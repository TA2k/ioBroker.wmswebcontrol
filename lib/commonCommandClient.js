"use strict";

// Warema WMS commonCommand protocol client.
//
// The controller exposes the same commonCommand API over two transports that share one
// id space (destinationId / actionId / sceneId), so a tree discovered locally can be
// driven over either transport:
//   - local:  POST http://<host>/commonCommand      (no auth, single JSON envelope)
//   - cloud:  POST <cloudBase>/wcp/<serial>/<op>     (bearer auth, per-operation path)
//
// This client prefers the local transport and falls back to the cloud when local is
// unreachable. getConfiguration exists only locally (the cloud has no such endpoint), so
// the object tree can only be discovered while the controller is reachable on the LAN.
//
// Reads fall back freely (idempotent). Writes only fall back to the other transport when
// the first attempt provably never reached the device (connection could not be
// established), so a command the controller already accepted is never replayed.
//
// Verified live against a real controller and the production cloud on 2026-09-23:
//   local  getStatus body {destinations:[id]} (one per call), action {responseType,actions[]},
//          scene command name "sceneActions" (plural, from pywmspro).
//   cloud  /ping, /status body [id,...] (array of int32), /action ActionCommandDto,
//          /scene SceneCommandDto {sceneId, sceneActionType}. /discovery and
//          /getConfiguration do not exist cloud-side (404).

// actionType enum from getConfiguration (pywmspro const.py).
const ACTION_TYPE = {
  PERCENTAGE: 0,
  PERCENTAGE_DELTA: 1,
  ROTATION: 2,
  ROTATION_DELTA: 3,
  SWITCH: 4,
  TOGGLE: 5,
  STOP: 6,
  IMPULSE: 7,
  IDENTIFY: 8,
  ENUMERATION: 9,
};

// actionDescription enum from getConfiguration (pywmspro const.py). Used only to pick a
// readable object name per action; the protocol keys off actionType.
const ACTION_DESC = {
  AWNING_DRIVE: 0,
  VALANCE_DRIVE: 1,
  SLAT_DRIVE: 2,
  SLAT_ROTATE: 3,
  ROLLER_SHUTTER_BLIND_DRIVE: 4,
  WINDOW_DRIVE: 5,
  LIGHT_SWITCH: 6,
  LOAD_SWITCH: 7,
  LIGHT_DIMMING: 8,
  LOAD_DIMMING: 9,
  LIGHT_TOGGLE: 10,
  LAST_TOGGLE: 11,
  MANUAL_COMMAND: 12,
  IDENTIFY: 13,
};

// axios error codes that mean no connection was established, so a write never reached the
// controller and may be safely retried on the other transport. Timeouts and resets are
// excluded: the command may have been delivered before the socket failed.
const NOT_DELIVERED_CODES = ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"];

class CommonCommandClient {
  /**
   * @param {object} options
   * @param {import("axios").AxiosInstance} options.requestClient shared axios client
   * @param {{debug: Function, info: Function, error: Function}} [options.log]
   * @param {string|null} [options.localHost] controller IP/host for the local transport
   * @param {string|null} [options.cloudBase] commonCommandService base URL for the cloud transport
   * @param {string|null} [options.serial] controller serial number (cloud path segment)
   * @param {() => string} [options.getToken] returns the current cloud bearer token
   * @param {(() => Promise<void>)|null} [options.refreshAuth] refreshes the cloud token on a 401
   */
  constructor(options) {
    this.requestClient = options.requestClient;
    this.log = options.log || { debug() {}, info() {}, error() {} };
    this.localHost = options.localHost || null;
    this.cloudBase = options.cloudBase || null;
    this.serial = options.serial || null;
    this.getToken = options.getToken || (() => "");
    this.refreshAuth = options.refreshAuth || null;
    // Whether the last pingLocal() succeeded; drives transport selection per cycle.
    this.localReachable = false;
    // Local getStatus must not be hammered; keep at least statusWaitMs between calls.
    this.lastStatusTs = 0;
    this.statusWaitMs = 500;
    // Set on shutdown so in-flight loops stop issuing further requests.
    this.stopped = false;
  }

  hasLocal() {
    return !!this.localHost;
  }
  hasCloud() {
    return !!(this.cloudBase && this.serial);
  }

  /**
   * Stop the client: pending status loops and throttle waits bail out and no further
   * requests are issued.
   */
  stop() {
    this.stopped = true;
  }

  /**
   * POST a commonCommand envelope to the local controller.
   * @param {string} command
   * @param {object} [extra] command-specific fields merged into the envelope
   * @returns {Promise<any>} response body
   */
  async localCommand(command, extra) {
    if (this.stopped) {
      throw new Error("client stopped");
    }
    const res = await this.requestClient({
      method: "post",
      url: "http://" + this.localHost + "/commonCommand",
      timeout: 5000,
      headers: { "content-type": "application/json", accept: "application/json" },
      data: Object.assign({ protocolVersion: "1.0", command: command, source: 2 }, extra || {}),
    });
    return res.data;
  }

  /**
   * POST to a cloud commonCommand per-operation endpoint. On a 401 it refreshes the token
   * once (if a refreshAuth callback was provided) and retries.
   * @param {string} op ping | status | action | scene
   * @param {any} body operation body
   * @param {boolean} [allowAuthRetry] retry once after refreshing on 401
   * @returns {Promise<any>} response body
   */
  async cloudCommand(op, body, allowAuthRetry = true) {
    if (this.stopped) {
      throw new Error("client stopped");
    }
    try {
      const res = await this.requestClient({
        method: "post",
        url: this.cloudBase + "/wcp/" + this.serial + "/" + op,
        timeout: 15000,
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          "accept-language": "de-DE;q=1",
          authorization: "Bearer " + this.getToken(),
        },
        data: body,
      });
      return res.data;
    } catch (error) {
      if (allowAuthRetry && this.refreshAuth && error && error.response && error.response.status === 401) {
        this.log.debug("Cloud commonCommand 401, refreshing token and retrying once");
        await this.refreshAuth();
        return this.cloudCommand(op, body, false);
      }
      throw error;
    }
  }

  /**
   * Run a read on the preferred transport, falling back to the other one on any failure
   * (reads are idempotent). The poll cycle sets localReachable via pingLocal.
   * @param {() => Promise<any>} localFn
   * @param {() => Promise<any>} cloudFn
   */
  async runRead(localFn, cloudFn) {
    if (this.localReachable) {
      try {
        return await localFn();
      } catch (error) {
        if (!this.hasCloud()) {
          throw error;
        }
        this.log.debug("Local read failed, cloud fallback: " + (error && error.message));
        return cloudFn();
      }
    }
    if (this.hasCloud()) {
      try {
        return await cloudFn();
      } catch (error) {
        if (!this.hasLocal()) {
          throw error;
        }
        this.log.debug("Cloud read failed, local retry: " + (error && error.message));
        return localFn();
      }
    }
    return localFn();
  }

  /**
   * Run a write on the preferred transport, falling back to the other one only when the
   * first attempt provably never reached the controller, so an accepted command is never
   * replayed (which could move a shutter twice).
   * @param {() => Promise<any>} localFn
   * @param {() => Promise<any>} cloudFn
   */
  async runWrite(localFn, cloudFn) {
    const notDelivered = (error) => !!error && !error.response && NOT_DELIVERED_CODES.includes(error.code);
    if (this.localReachable) {
      try {
        return await localFn();
      } catch (error) {
        if (this.hasCloud() && notDelivered(error)) {
          this.log.debug("Local write not delivered, cloud fallback: " + (error && error.code));
          return cloudFn();
        }
        throw error;
      }
    }
    if (this.hasCloud()) {
      try {
        return await cloudFn();
      } catch (error) {
        if (this.hasLocal() && notDelivered(error)) {
          this.log.debug("Cloud write not delivered, local retry: " + (error && error.code));
          return localFn();
        }
        throw error;
      }
    }
    return localFn();
  }

  /**
   * Throw when a commonCommand response carries protocol-level errors, so a rejected
   * scene/action is not reported as success.
   * @param {any} data response body
   * @returns {any} the same body when there are no errors
   */
  checkCommandResult(data) {
    if (data && Array.isArray(data.errors) && data.errors.length) {
      throw new Error("commonCommand rejected: errors " + JSON.stringify(data.errors));
    }
    return data;
  }

  /**
   * Ping the local controller and remember reachability for transport selection.
   * @returns {Promise<boolean>}
   */
  async pingLocal() {
    if (!this.hasLocal()) {
      this.localReachable = false;
      return false;
    }
    try {
      const data = await this.localCommand("ping", {});
      this.localReachable = !!(data && data.status === 0);
    } catch {
      this.localReachable = false;
    }
    return this.localReachable;
  }

  /**
   * Read the full controller configuration. Local transport only.
   * @returns {Promise<any>} { destinations, rooms, scenes }
   */
  async getConfiguration() {
    if (!this.hasLocal()) {
      throw new Error("getConfiguration requires local access");
    }
    return this.checkCommandResult(await this.localCommand("getConfiguration", {}));
  }

  async throttleLocalStatus() {
    if (this.stopped) {
      return;
    }
    const wait = this.statusWaitMs - (Date.now() - this.lastStatusTs);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastStatusTs = Date.now();
  }

  /**
   * Read status for one or more destinations. Returns a flat array of
   * { destinationId, data } for both transports (local queries one id per call and
   * throttles; cloud sends all ids in a single array request).
   * @param {number|number[]} destinationIds
   * @returns {Promise<Array<{destinationId: number, data: any}>>}
   */
  async getStatus(destinationIds) {
    const ids = Array.isArray(destinationIds) ? destinationIds : [destinationIds];
    return this.runRead(
      async () => {
        const details = [];
        for (const id of ids) {
          if (this.stopped) {
            break;
          }
          await this.throttleLocalStatus();
          const data = await this.localCommand("getStatus", { destinations: [id] });
          for (const detail of (data && data.details) || []) {
            if (detail.destinationId == null) {
              detail.destinationId = id;
            }
            details.push(detail);
          }
        }
        return details;
      },
      async () => {
        const data = await this.cloudCommand("status", ids);
        return (data && data.details) || [];
      },
    );
  }

  /**
   * Execute one or more actions. Each action is { destinationId, actionId, parameters }.
   * @param {Array<{destinationId: number, actionId: number, parameters: object}>} actions
   */
  async action(actions) {
    const body = { responseType: 0, actions: actions };
    return this.runWrite(
      async () => this.checkCommandResult(await this.localCommand("action", body)),
      async () => this.checkCommandResult(await this.cloudCommand("action", body)),
    );
  }

  /**
   * Execute a scene.
   * @param {number} sceneId
   */
  async executeScene(sceneId) {
    return this.runWrite(
      async () => this.checkCommandResult(await this.localCommand("sceneActions", { responseType: 0, sceneId: sceneId, sceneActionType: 1 })),
      async () => this.checkCommandResult(await this.cloudCommand("scene", { sceneId: sceneId, sceneActionType: 1 })),
    );
  }
}

module.exports = { CommonCommandClient, ACTION_TYPE, ACTION_DESC };
