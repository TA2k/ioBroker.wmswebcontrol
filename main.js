"use strict";

/*
 * Created with @iobroker/create-adapter v1.33.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const { HttpsCookieAgent } = require("http-cookie-agent/http");
const tough = require("tough-cookie");
const crypto = require("crypto");
const os = require("os");
const Json2iob = require("json2iob");
const { CommonCommandClient, ACTION_TYPE, ACTION_DESC } = require("./lib/commonCommandClient");

// Readable object names per actionDescription for the level (Percentage/Rotation) and
// Switch actions. A destination can expose several actions of the same type (e.g. an awning
// with a separate valance drive), so the name comes from the description, not the type. The
// protocol itself keys off actionType; these maps only make the object tree legible.
const PERCENTAGE_NAME = {
  [ACTION_DESC.AWNING_DRIVE]: "position",
  [ACTION_DESC.SLAT_DRIVE]: "position",
  [ACTION_DESC.ROLLER_SHUTTER_BLIND_DRIVE]: "position",
  [ACTION_DESC.VALANCE_DRIVE]: "valance",
  [ACTION_DESC.WINDOW_DRIVE]: "window",
  [ACTION_DESC.LIGHT_DIMMING]: "dimming",
  [ACTION_DESC.LOAD_DIMMING]: "loadDimming",
};
const SWITCH_NAME = {
  [ACTION_DESC.LIGHT_SWITCH]: "light",
  [ACTION_DESC.LOAD_SWITCH]: "load",
};

// Local status is polled on a fixed short cadence (the local API only throttles to ~0.5 s
// per call), independent of the minute-based cloud interval. Home Assistant's wmspro polls
// every 5 s; 15 s stays well clear of the reports that very fast local polling can lock up
// the controller over time.
const LOCAL_POLL_MS = 15000;

class Wmswebcontrol extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: "wmswebcontrol",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.cookieJar = new tough.CookieJar();
    // Single cookie-aware axios client for the whole adapter: the OAuth2
    // login/redirect flow relies on the cookie jar, the cloud API calls just
    // reuse it with a Bearer header. Certificate errors are ignored on purpose
    // (the cloud hosts intermittently serve chains Node rejects).
    this.webUserAgent =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
    this.requestClient = axios.create({
      withCredentials: true,
      timeout: 60000,
      httpsAgent: new HttpsCookieAgent({
        cookies: { jar: this.cookieJar },
        rejectUnauthorized: false,
      }),
      headers: {
        "accept-language": "de-de",
        "user-agent": this.webUserAgent,
      },
    });
    this.json2iob = new Json2iob(this);
    this.aToken = "";
    this.rToken = "";
    this.code_verifier = "";
    this.userAgent = "WMS WebControl pro/3.9.6 (iPhone; iOS 16.7.6; Scale/3.00)";
    this.appVersion = "3.9.6";
    // Service base URLs are resolved from the discovery service after login.
    // Defaults match the production discovery response and act as a fallback.
    this.discoveryUrl = "https://discoveryservice.prod.devicecloud.warema.de/api/discovery";
    this.messagingService = "https://devicecloudservice.prod.devicecloud.warema.de/api/v1.0/communication";
    this.registryService = "https://devicecloudservice.prod.devicecloud.warema.de/api/v1.0/devices";
    this.commonCommandService = "https://devicecloudservice.prod.devicecloud.warema.de/api/v1.0/command";
    this.appUpdateInterval = null;
    // Number of consecutive status polls that returned no data. info.connection is
    // only flipped to false after several failures so a single transient hiccup
    // does not flatter the connection indicator.
    this.failedStatusCycles = 0;

    this.deviceList = [];
    this.sceneList = [];
    this.channelList = [];
    // commonCommand mode: when a reachable controller is configured or discovered, the
    // adapter builds its tree from the local getConfiguration and drives it over the
    // commonCommand API, preferring the local transport and falling back to the cloud
    // commonCommand endpoints (same id space) when local is unreachable. The legacy
    // postMessage/mb8 cloud path below stays as a fallback for when the controller is
    // never reachable on the LAN.
    this.cc = null;
    this.ccActive = false;
    this.ccDestinations = [];
    this.ccScenes = [];
    // Cached local host (config IP or a discovered address) so the self-heal retry does
    // not re-scan the LAN on every poll while the controller is temporarily down.
    this.localHost = null;
    // Number of controllers in the cloud registry. The cloud commonCommand fallback is
    // only enabled when there is exactly one, so a multi-controller account cannot route
    // fallback commands to the wrong controller (the local controller cannot otherwise be
    // matched to a registry entry).
    this.registryDeviceCount = 0;
    // Set from onReady; drives the local self-heal retry in pollStatus.
    this.wantsLocal = false;
    // Timestamp of the last cloud status poll, so cloud fallback keeps the minute-based
    // interval even while the loop itself runs on the faster local cadence.
    this.lastCloudPollTs = 0;
    // Timestamp of the last LAN scan, so the poll self-heal does not rescan on every tick.
    this.lastScanTs = 0;
    // Guards against overlapping poll cycles when a poll runs longer than the interval.
    this.polling = false;
    // Set in onUnload so an async setup that started before shutdown does not publish a
    // client or object tree after the adapter has been told to stop.
    this.unloaded = false;
    // Guards a background LAN scan and against overlapping commonCommand setups.
    this.discovering = false;
    this.settingUp = false;
    this.states = {
      textIndexDrivingCause: {
        498: "Heartbeat Sicherheitskontakt",
        499: "Heartbeat Sicherheitskontakt Ende",
        500: "Heartbeat Wind",
        501: "Heartbeat Wind Ende",
        502: "Heatbeat Eis",
        503: "Heartbeat Eis Ende",
        504: "Heartbeat Niederschlag",
        505: "Heartbeat Niederschlag Ende",
        506: "Windalarm",
        507: "Windalarm Ende",
        508: "Eisalarm",
        509: "Eisalarm Ende",
        510: "Niederschlag",
        511: "Niederschlag Ende",
        512: "Sicherheitskontakt",
        513: "Sicherheitskontakt Ende",
        514: "Zentralbefehl",
        515: "Zentralbefehl Ende",
        516: "Automatiken deaktiviert",
        517: "Sonne",
        518: "Wolke",
        519: "Dämmerung morgens",
        520: "Dämmerung abends",
        521: "Temperatur warm",
        522: "Temperatur kalt",
        523: "Schaltzeitpunkt 1",
        524: "Schaltzeitpunkt 2",
        525: "Schaltzeitpunkt 3",
        526: "Schaltzeitpunkt 4",
        527: "Szene lernen",
        528: "Manuelle Bedienung",
        529: "Manuelle Bedienung Ende",
        530: "Abwesend",
        531: "Komfortposition lernen",
        532: "Komfortposition ausführen",
        533: "Winken",
        534: "Laufzeit lernen starten",
        535: "Laufzeit lernen beenden",
        536: "System start",
        537: "Unterbrechung einer Automatik",
        539: "Schrittweise ausfahren",
        540: "Anwesend",
        541: "Thermoschutz",
        542: "Thermoschutz Ende",
        543: "Hindernis bei Hochfahrt",
        544: "Hindernis bei Tieffahrt",
        545: "Motorparametriermodus",
        546: "Motorparametriermodus beendet",
        547: "Akkuspannung niedrig",
        548: "Akkuspannung niedrig Ende",
        549: "Kommunikationsfehler mit Wendemotor",
        550: "Positionierungsfehler",
        unknown: "Unbekannt",
      },
      textIndexFunctionCode: {
        0: " ",
        1: " ",
        532: "Komfortposition ausführen",
        571: " ",
        572: " ",
        573: "Stop",
        574: "Sollposition direkt",
        575: "Sollposition",
        576: "Impuls-wenden hoch",
        577: "Impuls-wenden tief",
        578: "Hochfahren",
        579: "Tieffahren",
        580: "Szene ausführen",
        581: "Szene lernen",
        582: "Toggeln",
        583: "Aufdimmen",
        584: "Abdimmen",
        585: "Hochfahren Markise",
        586: "Tieffahren Markise",
        587: "Hochfahren Volant-Rollo",
        588: "Tieffahren Volant-Rollo",
        589: "Hochfahren nur Volant-Rollo 1",
        590: "Tieffahren nur Volant-Rollo 1",
        591: "Hochfahren nur Volant-Rollo 2",
        592: "Tieffahren nur Volant-Rollo 2",
        593: "Einschalten",
        594: "Ausschalten",
        595: "Taste Stop direkt",
        596: "Taste Stop kurz",
        597: "Taste Stop lang",
        598: "Taste Stop doppelt",
        599: "Taste Hoch direkt",
        600: "Taste Hoch kurz",
        601: "Taste Hoch lang",
        602: "Taste Hoch doppelt",
        603: "Taste Tief direkt",
        604: "Taste Tief kurz",
        605: "Taste Tief lang",
        606: "Taste Tief doppelt",
        607: "Zentralbefehl setzen",
        608: "Blockierung durch Zentralbefehl lösen",
        609: "Abwesend setzen",
        610: "Abwesend löschen",
        611: "letzten manuellen nachholen",
        612: "letzten manuellen oder Komfortautomatikbefehl nachholen",
        613: "Winken",
        614: "Winken Volant-Rollo 1",
        615: "Winken Volant-Rollo 2",
        616: "Einen Schritt (10%) hoch",
        617: "Einen Schritt (10%) tief",
        618: "Letzten Befehl nachholen",
        621: "Stop von Subnetzpartner",
        622: "Sollposition von Subnetzpartner",
        623: "Winkbefehl von Subnetzpartner",
        unknown: "Unbekannt",
      },
    };
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Initialize your adapter here

    // Reset the connection indicator during startup
    this.setState("info.connection", false, true);

    if (this.config.interval < 1) {
      this.config.interval = 1;
    }
    // Local polling runs in seconds; floor at 5 s so a mistaken 0/1 cannot hammer the
    // controller. Falls back to the default when unset.
    if (!this.config.localInterval || this.config.localInterval < 5) {
      this.config.localInterval = LOCAL_POLL_MS / 1000;
    }
    const hasCloud = !!(this.config.user && this.config.password);
    this.wantsLocal = !!(this.config.localIp || this.config.autodiscover);
    if (!hasCloud && !this.wantsLocal) {
      this.log.info("Please enter your username and password, or a local controller IP!");
      return;
    }
    // in this template all states changes inside the adapters namespace are subscribed
    this.subscribeStates("*");
    if (hasCloud) {
      await this.login();
      if (this.aToken) {
        await this.sleep(1000);
        await this.getServiceMap();
        await this.getDeviceInfo();
        this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
        this.refreshTokenInterval = setInterval(() => {
          this.refreshToken().catch(() => {});
        }, 15 * 60 * 1000); // 15min
      }
    }
    // Prefer commonCommand mode: build the tree from the local getConfiguration when the
    // controller is reachable. Fall back to the legacy postMessage/mb8 cloud tree only
    // when the controller cannot be reached on the LAN at all.
    await this.setupCommonCommand();
    // setupCommonCommand can abort on unload (leaving this.cc null); do not then build the
    // legacy cloud tree after the adapter has already been unloaded.
    if (this.unloaded) {
      return;
    }
    if (!this.cc && this.aToken) {
      await this.getDeviceList();
      await this.getSceneList();
      await this.getChannelList();
    }
    // When no IP is configured, kick off the LAN scan in the background so a full /24 scan
    // never delays startup; it builds and publishes the local tree once the controller is
    // found. Not awaited on purpose.
    void this.maybeDiscoverLocal();

    if (!this.unloaded && (this.aToken || this.cc || this.wantsLocal)) {
      await this.sleep(5000);
      // Setup may have been slow; if the adapter was unloaded meanwhile, do not start polling.
      if (this.unloaded) {
        return;
      }
      await this.pollStatus();
      // The initial poll is another await where an unload can land; do not create an interval
      // the cleared onUnload would no longer know about.
      if (this.unloaded) {
        return;
      }
      this.appUpdateInterval = setInterval(async () => {
        await this.pollStatus();
        // Local status polls on the configured local interval (seconds); the pure cloud
        // path keeps the minute interval. When local is wanted the loop runs on the fast
        // cadence and the cloud fallback throttles itself inside pollStatus.
      }, this.wantsLocal ? this.config.localInterval * 1000 : this.config.interval * 60 * 1000);
    }
  }

  async login() {
    const [code_verifier, codeChallenge] = this.getCodeChallenge();
    const nonce = this.randomString(50);
    const state = this.randomString(50);
    this.log.debug(`Start login with nonce: ${nonce} and state: ${state}`);

    // 1. authorize -> axios follows the redirect to the login page
    const authResponse = await this.requestClient({
      method: "get",
      url: "https://auth.warema.de/v1/connect/authorize",
      params: {
        redirect_uri: "wcpmobileapp://pages/redirect",
        client_id: "devicecloud_wcpmobileapp",
        response_type: "code",
        grant_type: "authorization_code",
        nonce: nonce,
        state: state,
        scope:
          "openid profile offline_access devicecloud_devicecloudservice_devices_get devicecloud_devicecloudservice_devices_register devicecloud_devicecloudservice_devices_unregister devicecloud_devicecloudservice_commoncommand_action devicecloud_devicecloudservice_commoncommand_discovery devicecloud_devicecloudservice_commoncommand_ping devicecloud_devicecloudservice_commoncommand_scene devicecloud_devicecloudservice_commoncommand_status devicecloud_devicecloudservice_communication_systemnative",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      },
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }).catch((error) => {
      this.log.error("Authorize request failed: " + this.formatError(error));
      return null;
    });
    if (!authResponse) {
      return;
    }
    // The login page URL (with its ReturnUrl query) is where the form posts back to.
    const loginUrl = "https://auth.warema.de" + authResponse.request.path;
    let token;
    try {
      token = authResponse.data.split('RequestVerificationToken" type="hidden" value="')[1].split('" />')[0];
    } catch (error) {
      this.log.error("Could not find verification token, please check username and password");
      this.log.error(String(error));
      return;
    }
    this.log.debug("Found Token: " + token);

    // 2. submit credentials; axios follows the 302 as a GET and lands on the meta-refresh page
    const loginResponse = await this.requestClient({
      method: "post",
      url: loginUrl,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "content-type": "application/x-www-form-urlencoded",
      },
      data:
        "Input.Username=" +
        encodeURIComponent(this.config.user) +
        "&Input.Password=" +
        encodeURIComponent(this.config.password) +
        "&Input.RememberMe=true&button=login&__RequestVerificationToken=" +
        encodeURIComponent(token) +
        "&Input.RememberMe=false",
    }).catch((error) => {
      this.log.error("Login request failed: " + this.formatError(error));
      return null;
    });
    if (!loginResponse) {
      return;
    }
    // The redirect page carries a meta refresh: content="0;url=/v1/connect/authorize/callback?..."
    let url = "";
    try {
      url = loginResponse.data.split("0;url=")[1].split('"')[0].replace(/&amp;/g, "&");
    } catch (error) {
      this.log.error(loginResponse.data);
      this.log.error("Please check username and password");
      this.log.error(String(error));
    }
    if (!url) {
      return;
    }
    this.log.debug("Redirect to: " + url);

    // 3. follow the callback without redirecting to receive the wcpmobileapp:// authorization code
    const callbackResponse = await this.requestClient({
      method: "get",
      url: "https://auth.warema.de" + url,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }).catch((error) => {
      this.log.error("Authorization callback failed: " + this.formatError(error));
      return null;
    });
    if (!callbackResponse) {
      return;
    }
    let code;
    try {
      const location = new URL(callbackResponse.headers.location);
      code = location.searchParams.get("code");
      const oauthError = location.searchParams.get("error");
      if (oauthError) {
        this.log.error("OAuth error: " + oauthError + " " + (location.searchParams.get("error_description") || ""));
      }
    } catch (error) {
      this.log.error("Could not extract authorization code");
      this.log.error(String(error));
    }
    if (!code) {
      return;
    }
    this.log.debug("code: " + code);

    // 4. exchange the code for tokens
    await this.requestClient({
      method: "post",
      url: "https://auth.warema.de/v1/connect/token",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "content-type": "application/x-www-form-urlencoded",
      },
      data: new URLSearchParams({
        client_id: "devicecloud_wcpmobileapp",
        client_secret: "nosecret",
        code: code,
        code_verifier: code_verifier,
        grant_type: "authorization_code",
        redirect_uri: "wcpmobileapp://pages/redirect",
      }).toString(),
    })
      .then((response) => {
        this.setState("info.connection", true, true);
        this.log.info("Login successful");
        this.log.debug(JSON.stringify(response.data));
        this.aToken = response.data.access_token;
        this.rToken = response.data.refresh_token;
      })
      .catch(async (error) => {
        this.log.error("Token exchange failed: " + this.formatError(error));
        if (error.response && error.response.status === 400) {
          this.log.error("Login was not successful, restart adapter");
          await this.sleep(10000);
          this.restart();
        }
      });
  }
  async sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  /**
   * Build a compact, informative one-line description of a request error:
   * the HTTP status plus the server's WMS error (code and message) when the body
   * carries one, or the network/timeout error code otherwise, followed by the
   * error message. Avoids the bare "Request failed with status code 400" that
   * hides the actual cause (e.g. WMS 4001 "device not connected to the iot hub").
   * @param {any} error
   */
  formatError(error) {
    if (!error) {
      return "unknown error";
    }
    const parts = [];
    if (error.response) {
      parts.push("HTTP " + error.response.status);
      const data = error.response.data;
      const wms = Array.isArray(data) ? data[0] : null;
      if (wms && wms.code != null) {
        parts.push("WMS " + wms.code + (wms.message ? " " + wms.message : ""));
      } else if (data != null) {
        parts.push(typeof data === "string" ? data : this.safeStringify(data));
      }
    } else if (error.code) {
      parts.push(error.code);
    }
    if (error.message) {
      parts.push(error.message);
    }
    return parts.length ? parts.join(" - ") : String(error);
  }
  /**
   * JSON.stringify that never throws, so formatError stays safe inside catch handlers.
   * @param {any} value value to serialize
   * @returns {string} JSON string, or String(value) if serialization fails
   */
  safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  /**
   * Retry a request on transient failures (network errors, timeouts, 5xx, 408, 429).
   * Each attempt issues a fresh request. Client errors (auth, bad request,
   * device-offline 4001) are not retried and rethrown at once. A missing
   * error.response means a network/timeout/read error, which is always transient.
   * @param {() => Promise<any>} requestFn
   * @param {number} [limit]
   */
  async retryRequest(requestFn, limit = 2) {
    return requestFn().catch(async (error) => {
      const status = error && error.response && error.response.status;
      // A cancelled request is never retried; otherwise a missing response means a
      // network/timeout/read error (transient), and only 5xx/408/429 are retriable.
      const canceled = error && error.code === "ERR_CANCELED";
      const retriable = !canceled && (!status || status >= 500 || status === 408 || status === 429);
      if (!retriable || limit <= 0) {
        throw error;
      }
      this.log.debug("Request failed (" + (status || (error && error.code) || "network") + "), retrying, " + limit + " left");
      await this.sleep(2000);
      return this.retryRequest(requestFn, limit - 1);
    });
  }
  async refreshToken() {
    this.log.debug("refresh token");
    await this.requestClient({
      method: "post",
      url: "https://auth.warema.de/v1/connect/token",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "content-type": "application/x-www-form-urlencoded",
      },
      data: new URLSearchParams({
        client_id: "devicecloud_wcpmobileapp",
        client_secret: "nosecret",
        code_verifier: this.code_verifier,
        grant_type: "refresh_token",
        redirect_uri: "wcpmobileapp://pages/redirect",
        refresh_token: this.rToken,
      }).toString(),
    })
      .then((response) => {
        this.log.debug(JSON.stringify(response.data));
        this.aToken = response.data.access_token;
        this.rToken = response.data.refresh_token;
      })
      .catch((error) => {
        this.log.error("Token refresh failed: " + this.formatError(error));
        // Rethrow so the 401 handler in genericPostMessage falls through to relogin
        // instead of retrying with a stale token.
        throw error;
      });
  }
  async getDeviceInfo() {
    this.log.info("get devices");
    await this.retryRequest(() =>
      this.requestClient({
        method: "get",
        url: this.registryService,
        headers: {
          Accept: "*/*",
          "accept-encoding": "gzip, deflate, br",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": this.userAgent,
          "accept-language": "de-DE;q=1",
          authorization: "Bearer " + this.aToken,
        },
      }),
    )
      .then((response) => {
        const res = response.data;
        this.log.debug(JSON.stringify(res));
        if (!res.result) {
          this.log.error("No devices found");
          return;
        }
        this.log.info("Devices found: " + res.result.length);
        this.registryDeviceCount = res.result.length;
        if (res.result) {
          this.json2iob.parse("devices", res.result, { preferedArrayName: "serialNumber" });
          this.webControlId = res.result[0].serialNumber;
          this.retryRequest(() =>
            this.requestClient({
              method: "post",
              url: this.messagingService + "/wcp/" + this.webControlId + "/postMessage/",
              headers: {
                accept: "*/*",
                "content-type": "application/json",
                "user-agent": this.userAgent,
                "accept-language": "de-DE;q=1",
                authorization: "Bearer " + this.aToken,
              },
              data: { action: "info", changeIds: [] },
            }),
          )
            .then((response) => {
              const res = response.data;
              this.log.debug(JSON.stringify(res));
              if (res.response) {
                this.json2iob.parse("devices." + this.webControlId, res.response);
              }
            })
            .catch((error) => {
              this.log.error("Get controller info failed: " + this.formatError(error));
            });
        }
      })
      .catch((error) => {
        this.log.error("Get devices failed: " + this.formatError(error));
      });
  }
  async getServiceMap() {
    // Resolve service base URLs from the discovery service (introduced in app 3.9.x).
    // Keeps the hardcoded defaults on failure so the adapter still works.
    await this.requestClient({
      method: "get",
      url: this.discoveryUrl + "/app/wcpMobile/" + this.appVersion,
      timeout: 5000,
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": this.userAgent,
        "accept-language": "de-DE;q=1",
      },
    })
      .then((response) => {
        const res = response.data;
        this.log.debug(JSON.stringify(res));
        if (res.messagingService) {
          this.messagingService = res.messagingService;
        }
        if (res.registryService) {
          this.registryService = res.registryService;
        }
        if (res.commonCommandService) {
          this.commonCommandService = res.commonCommandService;
        }
      })
      .catch((error) => {
        this.log.error("Discovery failed, using default endpoints: " + this.formatError(error));
      });
  }
  async getDeviceList() {
    const resultData = await this.genericPostMessage("mb8Read", {
      address: 0,
      block: 42,
      eui: parseInt(this.webControlId),
      length: 12800,
    });

    if (!resultData || !resultData.response || resultData.response.data == null) {
      this.log.error("Get device list failed: no data returned (the controller may be offline or not connected to the Warema cloud)");
      return;
    }
    this.log.debug(JSON.stringify(resultData.response));
    const result = Buffer.from(resultData.response.data, "base64");
    // The device table is a flat array of fixed 64-byte entries. Each entry starts
    // with the serial number as a little-endian uint32; the alias is a latin1 string
    // in bytes 24..63, terminated by the first null byte. Serial 0 marks an empty slot.
    const ENTRY_SIZE = 64;
    for (let offset = 0; offset + ENTRY_SIZE <= result.length; offset += ENTRY_SIZE) {
      const elementSerial = result.readUInt32LE(offset);
      if (elementSerial === 0) {
        continue;
      }
      let elementName = result.toString("latin1", offset + 24, offset + ENTRY_SIZE);
      const nullIndex = elementName.indexOf("\u0000");
      if (nullIndex !== -1) {
        elementName = elementName.substring(0, nullIndex);
      }
      // Keep the id usable as an ioBroker object id: dot is the state hierarchy
      // separator, so spaces and dots are stripped.
      elementName = elementName.replace(/ /g, "").replace(/\./g, "");
      this.deviceList.push({ id: elementSerial, name: elementName });
      await this.setObjectNotExistsAsync(elementName, {
        type: "device",
        common: {
          name: elementSerial.toString(),
          write: false,
          read: true,
        },
        native: {},
      });
    }
    if (!this.deviceList.length) {
      this.log.error("No devices found");
      return;
    }

    this.log.debug(JSON.stringify(this.deviceList));
    await this.getDeviceStatus().catch(() => {
      this.log.error("Get device status failed");
    });
  }
  async getDeviceStatus() {
    this.log.debug("get device status");
    let cycleOk = false;
    for (const element of this.deviceList) {
      this.log.debug("get status of: " + element.id);
      const resultData = await this.genericPostMessage("manualCommandRequest", {
        serialNumber: element.id,
        functionCode: 0,
        setting0: 255,
        setting1: 255,
        setting2: 255,
        setting3: 255,
      });
      if (resultData && resultData.response) {
        cycleOk = true;
        this.log.debug(JSON.stringify(resultData.response));
        await this.json2iob.parse(element.name, resultData.response, { forceIndex: true, states: this.states, write: true });
      } else {
        this.log.info("Get device status failed because response is empty");
      }
    }
    if (cycleOk) {
      this.failedStatusCycles = 0;
      this.setState("info.connection", true, true);
    } else if (this.deviceList.length) {
      this.failedStatusCycles++;
      if (this.failedStatusCycles >= 3) {
        this.setState("info.connection", false, true);
      }
    }
    //get sensors
    this.log.debug("get sensor status");
    const resultData = await this.genericPostMessage("sensorValueExportCurrent", {
      connectionType: 1,
      day: new Date().getDate(),
      eui: parseInt(this.webControlId),
      month: new Date().getMonth() + 1,
      sensorId: 255,
      year: parseInt(new Date().getFullYear().toString().substring(2)),
    }).catch((error) => {
      this.log.debug("No sensor data: " + this.formatError(error));
    });
    if (resultData && resultData.response) {
      this.log.debug(JSON.stringify(resultData.response));
      await this.json2iob.parse("sensors", resultData.response, { forceIndex: true, write: true });
    }
  }
  async setDeviceStatus(device, key, value) {
    this.log.debug("set status of: " + device.id + " key: " + key + " value: " + value);
    const data = { serialNumber: device.id, functionCode: 3 };

    const setting0 = await this.getStateAsync(device.name + ".setting0");
    if (setting0) {
      data.setting0 = setting0.val;
    }
    const setting1 = await this.getStateAsync(device.name + ".setting1");
    if (setting1) {
      data.setting1 = setting1.val;
    }
    const setting2 = await this.getStateAsync(device.name + ".setting2");
    if (setting2) {
      data.setting2 = setting2.val;
    }
    const setting3 = await this.getStateAsync(device.name + ".setting3");
    if (setting3) {
      data.setting3 = setting3.val;
    }
    data[key] = value;
    await this.genericPostMessage("manualCommandRequest", data, false)
      .then((result) => {
        this.log.debug("set status with result:");
        result.response && this.log.debug(JSON.stringify(result.response));
        this.waitTimeout = setTimeout(() => {
          this.getDeviceStatus().then(() => {
            this.waitTimeout = setTimeout(() => {
              this.getDeviceStatus();
            }, 15000);
          });
        }, 5000);
      })
      .catch((error) => {
        this.log.error("Set status failed for " + device.id + ": " + this.formatError(error));
      });
  }
  /**
   * Parse a WMS scene or channel list block into named entries. Both blocks share
   * the same 188-byte entry layout: bytes 28..67 hold the entry name (alias0) as a
   * latin1 string terminated by the first null byte. An entry's ordinal position is
   * its id (sceneNumber / channel number). Unnamed slots are skipped.
   * @param {Buffer} buffer decoded block bytes
   * @returns {{id: number, name: string}[]}
   */
  parseAliasList(buffer) {
    const ENTRY_SIZE = 188;
    const ALIAS_OFFSET = 28;
    const ALIAS_LENGTH = 40;
    const list = [];
    for (let index = 0, offset = 0; offset + ENTRY_SIZE <= buffer.length; index++, offset += ENTRY_SIZE) {
      let name = buffer.toString("latin1", offset + ALIAS_OFFSET, offset + ALIAS_OFFSET + ALIAS_LENGTH);
      const nullIndex = name.indexOf("\u0000");
      if (nullIndex !== -1) {
        name = name.substring(0, nullIndex);
      }
      // Keep the name usable as an ioBroker object id (dot is the hierarchy separator).
      name = name.replace(/ /g, "").replace(/\./g, "");
      if (!name) {
        continue;
      }
      list.push({ id: index, name: name });
    }
    return list;
  }
  async getSceneList() {
    // Scene table: a single mb8Read of block 48 (32 entries x 188 bytes).
    const resultData = await this.genericPostMessage("mb8Read", {
      address: 0,
      block: 48,
      eui: parseInt(this.webControlId),
      length: 6016,
    });
    if (!resultData || !resultData.response || resultData.response.data == null) {
      this.log.debug("No scene list returned");
      return;
    }
    this.sceneList = this.parseAliasList(Buffer.from(resultData.response.data, "base64"));
    for (const scene of this.sceneList) {
      await this.setObjectNotExistsAsync("scenes." + scene.name, {
        type: "state",
        common: {
          name: "Execute scene " + scene.id,
          role: "button",
          type: "boolean",
          write: true,
          read: false,
        },
        native: {},
      });
    }
    this.log.debug("scenes: " + JSON.stringify(this.sceneList));
  }
  async getChannelList() {
    // Channel table: block 50 (300 entries x 188 bytes = 56400). The controller
    // serves it in 18800-byte chunks at advancing byte offsets; the chunks are
    // concatenated before parsing (matches app 3.9.6).
    const BLOCK_SIZE = 56400;
    const CHUNK_SIZE = 18800;
    const chunks = [];
    for (let address = 0; address < BLOCK_SIZE; address += CHUNK_SIZE) {
      const length = Math.min(CHUNK_SIZE, BLOCK_SIZE - address);
      const resultData = await this.genericPostMessage("mb8Read", {
        address: address,
        block: 50,
        eui: parseInt(this.webControlId),
        length: length,
      });
      if (!resultData || !resultData.response || resultData.response.data == null) {
        this.log.debug("No channel list returned");
        return;
      }
      const chunk = Buffer.from(resultData.response.data, "base64");
      // A short chunk would shift every following channel's ordinal (its id), so
      // abort rather than build a misaligned list.
      if (chunk.length !== length) {
        this.log.warn("Channel list chunk length mismatch (" + chunk.length + " != " + length + "), skipping channel enumeration");
        return;
      }
      chunks.push(chunk);
    }
    this.channelList = this.parseAliasList(Buffer.concat(chunks));
    for (const channel of this.channelList) {
      await this.setObjectNotExistsAsync("channels." + channel.name, {
        type: "channel",
        common: { name: "Channel " + channel.id },
        native: {},
      });
      await this.setObjectNotExistsAsync("channels." + channel.name + ".position", {
        type: "state",
        common: { name: "Target position", role: "level.blind", type: "number", unit: "%", min: 0, max: 100, write: true, read: true },
        native: {},
      });
      await this.setObjectNotExistsAsync("channels." + channel.name + ".slatAngle", {
        type: "state",
        common: { name: "Target slat angle", role: "level.tilt", type: "number", min: -127, max: 127, write: true, read: true },
        native: {},
      });
      await this.setObjectNotExistsAsync("channels." + channel.name + ".stop", {
        type: "state",
        common: { name: "Stop movement", role: "button", type: "boolean", write: true, read: false },
        native: {},
      });
    }
    this.log.debug("channels: " + JSON.stringify(this.channelList));
  }

  /**
   * Strip characters that are not valid inside an ioBroker object id (dot is the
   * hierarchy separator; spaces are avoided).
   * @param {string} name
   * @returns {string}
   */
  sanitizeName(name) {
    return String(name == null ? "" : name)
      .replace(/ /g, "")
      .replace(/\./g, "");
  }

  /**
   * Resolve the local controller host from the configured IP or a previously discovered
   * (cached) host. Returns null when no host is available yet.
   * @returns {Promise<string|null>}
   */
  async resolveLocalHost() {
    if (this.config.localIp && this.config.localIp.trim()) {
      return this.config.localIp.trim();
    }
    // A discovered host is cached here; the LAN scan itself runs in the background
    // (maybeDiscoverLocal) so it never blocks startup or the poll loop.
    return this.localHost;
  }

  /**
   * Scan the /24 of every non-internal IPv4 interface for a controller answering
   * the local ping. Returns the first responder, or null.
   * @returns {Promise<string|null>}
   */
  async discoverLocalHost() {
    const nets = os.networkInterfaces();
    const bases = new Set();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === "IPv4" && !net.internal) {
          const parts = net.address.split(".");
          bases.add(parts[0] + "." + parts[1] + "." + parts[2]);
        }
      }
    }
    if (!bases.size) {
      return null;
    }
    const probe = async (ip) => {
      try {
        const res = await this.requestClient({
          method: "post",
          url: "http://" + ip + "/commonCommand",
          timeout: 1000,
          headers: { "content-type": "application/json", accept: "application/json" },
          data: { protocolVersion: "1.0", command: "ping", source: 2 },
        });
        return res.data && res.data.status === 0 ? ip : null;
      } catch {
        return null;
      }
    };
    const CONCURRENCY = 32;
    for (const base of bases) {
      const candidates = [];
      for (let i = 1; i <= 254; i++) {
        candidates.push(base + "." + i);
      }
      for (let start = 0; start < candidates.length; start += CONCURRENCY) {
        if (this.unloaded) {
          return null;
        }
        const results = await Promise.all(candidates.slice(start, start + CONCURRENCY).map(probe));
        const found = results.find((entry) => entry);
        if (found) {
          this.log.info("Discovered local controller at " + found);
          return found;
        }
      }
    }
    this.log.info("No local controller found via auto-discovery");
    return null;
  }

  /**
   * Run the LAN scan in the background when local is wanted but no host is resolved yet, so
   * a full /24 scan never delays startup. On success the host is cached and the local tree
   * is built. Guarded so only one scan runs and it is skipped once local is already active,
   * an IP is configured, or a host is already cached.
   * @returns {Promise<void>}
   */
  async maybeDiscoverLocal() {
    if (this.cc || this.discovering || !this.config.autodiscover) {
      return;
    }
    if ((this.config.localIp && this.config.localIp.trim()) || this.localHost) {
      return;
    }
    // The poll self-heal calls this on every cycle; throttle the full LAN scan so a
    // controller that stays unreachable is not scanned for on every short poll tick.
    if (this.lastScanTs && Date.now() - this.lastScanTs < 120000) {
      return;
    }
    this.lastScanTs = Date.now();
    this.discovering = true;
    try {
      const found = await this.discoverLocalHost();
      if (found && !this.unloaded) {
        this.localHost = found;
        await this.setupCommonCommand();
        await this.persistDiscoveredIp(found);
      }
    } catch (error) {
      this.log.debug("Background discovery failed: " + (error && error.message));
    } finally {
      this.discovering = false;
    }
  }

  /**
   * Save a discovered controller IP into the instance settings so it is visible in the
   * config dialog and subsequent starts skip the LAN scan. Writing native config restarts
   * the adapter once; guarded to write only when the value actually changes, so it cannot
   * loop (after the restart the configured IP is used and discovery no longer runs).
   * @param {string} ip
   */
  async persistDiscoveredIp(ip) {
    try {
      const id = "system.adapter." + this.namespace;
      const obj = await this.getForeignObjectAsync(id);
      if (obj && obj.native && obj.native.localIp !== ip) {
        await this.extendForeignObjectAsync(id, { native: { localIp: ip } });
        this.log.info("Saved discovered controller IP " + ip + " to the instance settings");
      }
    } catch (error) {
      this.log.debug("Could not persist discovered IP: " + (error && error.message));
    }
  }

  /**
   * Instantiate the commonCommand client and build its object tree when the controller
   * is reachable on the LAN. The client keeps the cloud commonCommand endpoints as a
   * transport fallback (same id space). Leaves this.cc null otherwise, so onReady falls
   * back to the legacy cloud tree.
   */
  async setupCommonCommand() {
    // A background discovery and the poll self-heal can both trigger setup; guard against
    // building the tree twice concurrently.
    if (this.settingUp) {
      return;
    }
    this.settingUp = true;
    try {
      await this.setupCommonCommandInner();
    } finally {
      this.settingUp = false;
    }
  }

  async setupCommonCommandInner() {
    const host = await this.resolveLocalHost();
    // Only enable the cloud transport when the registry holds exactly one controller, so a
    // multi-controller account cannot route fallback commands to the wrong controller.
    const serial = this.registryDeviceCount === 1 ? this.webControlId || null : null;
    if (this.registryDeviceCount > 1) {
      this.log.info("Multiple controllers in the account, cloud commonCommand fallback disabled (local only)");
    }
    const client = new CommonCommandClient({
      requestClient: this.requestClient,
      log: this.log,
      localHost: host,
      cloudBase: this.commonCommandService,
      serial: serial,
      getToken: () => this.aToken,
      refreshAuth: () => this.refreshToken(),
    });
    if (!host || !(await client.pingLocal())) {
      if (host) {
        this.log.info("Local controller at " + host + " not reachable, using cloud fallback");
      }
      client.stop();
      return;
    }
    // The adapter may have been unloaded while the ping was in flight; do not publish a
    // client or build a tree after shutdown.
    if (this.unloaded) {
      client.stop();
      return;
    }
    // Build the tree on the local client and only publish it as this.cc on success, so a
    // failed or aborted build never leaves a half-initialized client active. A build that
    // throws (e.g. an object write is rejected) must not escape setup: stop the temporary
    // client and let the caller fall back to the legacy cloud tree.
    let built = false;
    try {
      built = await this.buildCommonCommandTree(client);
    } catch (error) {
      this.log.error("Local commonCommand tree build failed: " + (error && error.message));
    }
    if (!built || this.unloaded) {
      client.stop();
      return;
    }
    this.cc = client;
    this.log.info("Local controller reachable at " + host + ", using commonCommand (local preferred)");
  }

  /**
   * Map a raw getConfiguration action to an object-tree state descriptor, or null when the
   * action type is not modeled. The parameter and status value keys come from the
   * commonCommand action wire format (percentage / rotation / onOffState); Stop, Toggle,
   * Impulse and Identify carry no parameters. Enumeration and Unknown are skipped because
   * their parameter shape is not established.
   * The returned base is the preferred (pre-uniqueness) state name; the caller assigns the
   * final stateName order-independently across the destination's actions.
   * @param {{id: number, actionType: number, actionDescription: number, minValue?: number, maxValue?: number}} action
   * @returns {{id: number, base: string, stateName: string, kind: string, paramKey: string|null, readKey: string|null, clampMin: number|null, clampMax: number|null, common: ioBroker.StateCommon}|null}
   */
  describeAction(action) {
    const type = action.actionType;
    const desc = action.actionDescription;
    const min = action.minValue != null ? action.minValue : null;
    const max = action.maxValue != null ? action.maxValue : null;
    let base;
    /** @type {ioBroker.StateCommon} */
    let common;
    /** @type {string|null} */
    let paramKey = null;
    /** @type {string|null} */
    let readKey = null;
    let kind;
    /** @type {number|null} */
    let clampMin = null;
    /** @type {number|null} */
    let clampMax = null;
    switch (type) {
      case ACTION_TYPE.PERCENTAGE: {
        base = PERCENTAGE_NAME[desc] || "position";
        kind = "level";
        paramKey = "percentage";
        readKey = "percentage";
        clampMin = 0;
        clampMax = 100;
        const dimmer = desc === ACTION_DESC.LIGHT_DIMMING || desc === ACTION_DESC.LOAD_DIMMING;
        const label = dimmer ? "Brightness" : desc === ACTION_DESC.VALANCE_DRIVE ? "Valance position" : "Target position";
        common = { name: label, role: dimmer ? "level.dimmer" : "level.blind", type: "number", unit: "%", min: 0, max: 100, write: true, read: true };
        break;
      }
      case ACTION_TYPE.PERCENTAGE_DELTA: {
        base = (PERCENTAGE_NAME[desc] || "position") + "Delta";
        kind = "level";
        paramKey = "percentage";
        // A delta action's own limits are relative bounds; use them directly when present.
        clampMin = min != null ? min : -100;
        clampMax = max != null ? max : 100;
        common = { name: "Relative position change", role: "level", type: "number", unit: "%", min: clampMin, max: clampMax, write: true, read: false };
        break;
      }
      case ACTION_TYPE.ROTATION: {
        base = desc === ACTION_DESC.SLAT_ROTATE ? "slatAngle" : "rotation";
        kind = "level";
        paramKey = "rotation";
        readKey = "rotation";
        clampMin = min != null ? min : -127;
        clampMax = max != null ? max : 127;
        common = { name: "Target slat angle", role: "level.tilt", type: "number", min: clampMin, max: clampMax, write: true, read: true };
        break;
      }
      case ACTION_TYPE.ROTATION_DELTA: {
        base = (desc === ACTION_DESC.SLAT_ROTATE ? "slatAngle" : "rotation") + "Delta";
        kind = "level";
        paramKey = "rotation";
        // A delta action's own limits are relative bounds; use them directly when present.
        clampMin = min != null ? min : -127;
        clampMax = max != null ? max : 127;
        common = { name: "Relative slat angle change", role: "level", type: "number", min: clampMin, max: clampMax, write: true, read: false };
        break;
      }
      case ACTION_TYPE.SWITCH: {
        base = SWITCH_NAME[desc] || "switch";
        kind = "switch";
        paramKey = "onOffState";
        readKey = "onOffState";
        common = { name: "On/off", role: desc === ACTION_DESC.LIGHT_SWITCH ? "switch.light" : "switch", type: "boolean", write: true, read: true };
        break;
      }
      case ACTION_TYPE.TOGGLE: {
        base = desc === ACTION_DESC.LIGHT_TOGGLE ? "lightToggle" : desc === ACTION_DESC.LAST_TOGGLE ? "lastToggle" : "toggle";
        kind = "button";
        common = { name: "Toggle", role: "button", type: "boolean", write: true, read: false };
        break;
      }
      case ACTION_TYPE.STOP: {
        base = "stop";
        kind = "button";
        common = { name: "Stop movement", role: "button.stop", type: "boolean", write: true, read: false };
        break;
      }
      case ACTION_TYPE.IMPULSE: {
        base = "impulse";
        kind = "button";
        common = { name: "Impulse", role: "button", type: "boolean", write: true, read: false };
        break;
      }
      case ACTION_TYPE.IDENTIFY: {
        base = "identify";
        kind = "button";
        common = { name: "Identify", role: "button", type: "boolean", write: true, read: false };
        break;
      }
      default:
        this.log.debug("commonCommand: unsupported actionType " + type + " (description " + desc + ") skipped");
        return null;
    }
    return { id: action.id, base: base, stateName: "", kind: kind, paramKey: paramKey, readKey: readKey, clampMin: clampMin, clampMax: clampMax, common: common };
  }

  /**
   * Assign a stable, order-independent, collision-free name to each item. A friendly bare
   * base name is kept only when it is unique among the items, not reserved, and does not equal
   * any item's qualified "base_id" form; every other item takes its qualified name. Because
   * ids are unique, qualified names never collide, so each item's name is a pure function of
   * the item set and does not depend on the order the controller reported them in. That keeps
   * object ids stable across rebuilds, so an existing automation never ends up pointing at a
   * different device.
   * @param {{base: string, id: number}[]} items
   * @param {Set<string>} reserved names that must not be taken as a bare name (e.g. a shared namespace)
   * @returns {string[]} the chosen name for each item, in the same order
   */
  assignUniqueNames(items, reserved) {
    /** @type {Map<string, number>} */
    const baseCounts = new Map();
    const qualifiedNames = new Set();
    for (const item of items) {
      baseCounts.set(item.base, (baseCounts.get(item.base) || 0) + 1);
      qualifiedNames.add(item.base + "_" + item.id);
    }
    return items.map((item) => {
      const bareIsUnique = baseCounts.get(item.base) === 1 && !reserved.has(item.base) && !qualifiedNames.has(item.base);
      return bareIsUnique ? item.base : item.base + "_" + item.id;
    });
  }

  /**
   * Read the local getConfiguration and create the local.* object tree on the given client:
   * one channel per destination with a state per modeled action (position/slatAngle/switch/
   * stop/identify/...), plus status states, and one button per scene. Returns false when the
   * configuration could not be read, so the caller does not publish the client.
   * @param {InstanceType<typeof CommonCommandClient>} client
   * @returns {Promise<boolean>}
   */
  /**
   * setObjectNotExists that stops when the adapter is unloading, so a build racing shutdown
   * does not keep creating objects.
   * @param {string} objId
   * @param {ioBroker.SettableObject} obj
   * @returns {Promise<boolean>} false when the adapter was unloaded (caller must abort the build)
   */
  async ccSetObject(objId, obj) {
    if (this.unloaded) {
      return false;
    }
    await this.setObjectNotExistsAsync(objId, obj);
    return true;
  }

  async buildCommonCommandTree(client) {
    let config;
    try {
      config = await client.getConfiguration();
    } catch (error) {
      this.log.error("Local getConfiguration failed: " + (error && error.message));
      return false;
    }
    if (this.unloaded) {
      // Adapter is shutting down; do not create objects.
      return false;
    }
    // Labeled parent for the whole local tree, so the folder is not shown unnamed.
    if (!(await this.ccSetObject("local", {
      type: "folder",
      common: { name: { en: "Local control (commonCommand)", de: "Lokale Steuerung (commonCommand)" } },
      native: {},
    }))) {
      return false;
    }
    // Collect destination descriptors first so folder names can be assigned across all
    // destinations at once (order-independent), before any object is created.
    const destInputs = /** @type {{id: number, display: string, base: string, actions: NonNullable<ReturnType<Wmswebcontrol["describeAction"]>>[]}[]} */ ([]);
    for (const dest of (config && config.destinations) || []) {
      const display = (dest.names && dest.names[0]) || "";
      const sane = this.sanitizeName(display);
      if (!sane) {
        continue;
      }
      const actions = /** @type {NonNullable<ReturnType<Wmswebcontrol["describeAction"]>>[]} */ ([]);
      for (const action of dest.actions || []) {
        const meta = this.describeAction(action);
        if (meta) {
          actions.push(meta);
        }
      }
      destInputs.push({ id: dest.id, display: display, base: sane, actions: actions });
    }
    // Reserve the scenes namespace so a destination named "scenes" cannot collide with the
    // scene buttons (dispatch routes local.scenes.* to scene execution).
    const usedDestNames = new Set(["scenes"]);
    const destNames = this.assignUniqueNames(destInputs, usedDestNames);
    const destinations = [];
    for (let i = 0; i < destInputs.length; i++) {
      const input = destInputs[i];
      const name = destNames[i];
      // Reserve the fixed status state names, then assign one order-independent state name
      // per action on this destination.
      const usedStates = new Set(["drivingCause", "heartbeatError", "blocking"]);
      const stateNames = this.assignUniqueNames(input.actions, usedStates);
      for (let j = 0; j < input.actions.length; j++) {
        input.actions[j].stateName = stateNames[j];
      }
      const mapped = { id: input.id, name: name, actions: input.actions };
      destinations.push(mapped);
      if (!(await this.ccSetObject("local." + name, {
        type: "channel",
        common: { name: input.display || name },
        native: {},
      }))) {
        return false;
      }
      for (const meta of mapped.actions) {
        if (!(await this.ccSetObject("local." + name + "." + meta.stateName, {
          type: "state",
          common: meta.common,
          native: {},
        }))) {
          return false;
        }
      }
      if (!(await this.ccSetObject("local." + name + ".drivingCause", {
        type: "state",
        // Local reports a numeric code, the cloud fallback a string enum, so accept both.
        common: { name: "Driving cause", role: "value", type: "mixed", write: false, read: true },
        native: {},
      }))) {
        return false;
      }
      if (!(await this.ccSetObject("local." + name + ".heartbeatError", {
        type: "state",
        common: { name: "Heartbeat error", role: "indicator", type: "boolean", write: false, read: true },
        native: {},
      }))) {
        return false;
      }
      if (!(await this.ccSetObject("local." + name + ".blocking", {
        type: "state",
        common: { name: "Blocking", role: "indicator", type: "boolean", write: false, read: true },
        native: {},
      }))) {
        return false;
      }
    }
    const sceneInputs = /** @type {{id: number, display: string, base: string}[]} */ ([]);
    for (const scene of (config && config.scenes) || []) {
      const display = (scene.names && scene.names[0]) || "";
      const sane = this.sanitizeName(display);
      if (!sane) {
        continue;
      }
      sceneInputs.push({ id: scene.id, display: display, base: sane });
    }
    const usedSceneNames = new Set();
    const sceneNames = this.assignUniqueNames(sceneInputs, usedSceneNames);
    const scenes = [];
    if (sceneInputs.length && !(await this.ccSetObject("local.scenes", {
      type: "folder",
      common: { name: { en: "Scenes", de: "Szenen" } },
      native: {},
    }))) {
      return false;
    }
    for (let i = 0; i < sceneInputs.length; i++) {
      const input = sceneInputs[i];
      const name = sceneNames[i];
      scenes.push({ id: input.id, name: name });
      if (!(await this.ccSetObject("local.scenes." + name, {
        type: "state",
        common: { name: input.display || name, role: "button", type: "boolean", write: true, read: false },
        native: {},
      }))) {
        return false;
      }
    }
    if (this.unloaded) {
      return false;
    }
    // Remove local.* objects the current configuration no longer produces (e.g. a state
    // renamed by a newer build, or a device removed on the controller), so setObjectNotExists
    // never leaves stale objects behind.
    const keep = new Set(["local"]);
    for (const dest of destinations) {
      keep.add("local." + dest.name);
      keep.add("local." + dest.name + ".drivingCause");
      keep.add("local." + dest.name + ".heartbeatError");
      keep.add("local." + dest.name + ".blocking");
      for (const meta of dest.actions) {
        keep.add("local." + dest.name + "." + meta.stateName);
      }
    }
    if (scenes.length) {
      keep.add("local.scenes");
      for (const scene of scenes) {
        keep.add("local.scenes." + scene.name);
      }
    }
    await this.pruneLocalObjects(keep);
    this.ccDestinations = destinations;
    this.ccScenes = scenes;
    this.log.debug("commonCommand destinations: " + JSON.stringify(this.ccDestinations));
    this.log.debug("commonCommand scenes: " + JSON.stringify(this.ccScenes));
    return true;
  }

  /**
   * Delete local.* objects that are not in the freshly built keep set. Enumerates the
   * instance objects, so orphans from an older build (renamed states, removed devices) are
   * cleaned up. Deepest ids first so states are removed before their channel.
   * @param {Set<string>} keep object ids (relative to the namespace) to preserve
   * @returns {Promise<void>}
   */
  async pruneLocalObjects(keep) {
    if (this.unloaded) {
      return;
    }
    let existing;
    try {
      existing = await this.getAdapterObjectsAsync();
    } catch (error) {
      this.log.debug("Local object cleanup skipped: " + (error && error.message));
      return;
    }
    const prefix = this.namespace + ".local.";
    const stale = [];
    for (const fullId of Object.keys(existing)) {
      if (!fullId.startsWith(prefix)) {
        continue;
      }
      const rel = fullId.slice(this.namespace.length + 1);
      if (!keep.has(rel)) {
        stale.push(rel);
      }
    }
    stale.sort((a, b) => b.split(".").length - a.split(".").length);
    for (const rel of stale) {
      if (this.unloaded) {
        return;
      }
      try {
        await this.delObjectAsync(rel);
        this.log.debug("Removed stale local object " + rel);
      } catch (error) {
        this.log.debug("Could not remove stale local object " + rel + ": " + (error && error.message));
      }
    }
  }

  /**
   * Poll status for every destination and write it into the local.* tree. Uses whichever
   * commonCommand transport is currently available (local preferred).
   */
  async pollCommonCommand() {
    const ids = this.ccDestinations.map((dest) => dest.id);
    if (!ids.length) {
      return;
    }
    let details;
    try {
      details = await this.cc.getStatus(ids);
    } catch (error) {
      this.log.debug("commonCommand status poll failed: " + (error && error.message));
      this.failedStatusCycles++;
      if (this.failedStatusCycles >= 3) {
        this.setState("info.connection", false, true);
      }
      return;
    }
    this.failedStatusCycles = 0;
    this.setState("info.connection", true, true);
    const updated = new Set();
    for (const detail of details) {
      const dest = this.ccDestinations.find((entry) => entry.id === detail.destinationId);
      if (!dest || !detail.data) {
        continue;
      }
      updated.add(detail.destinationId);
      const data = detail.data;
      const base = "local." + dest.name;
      const heartbeat = data.heartBeatError != null ? data.heartBeatError : data.heartbeatError;
      await this.setStateChangedAsync(base + ".drivingCause", { val: data.drivingCause != null ? data.drivingCause : null, ack: true });
      await this.setStateChangedAsync(base + ".heartbeatError", { val: !!heartbeat, ack: true });
      await this.setStateChangedAsync(base + ".blocking", { val: !!data.blocking, ack: true });
      for (const product of data.productData || []) {
        const value = product.value || {};
        const meta = dest.actions.find((entry) => entry.id === product.actionId && entry.readKey);
        if (!meta) {
          continue;
        }
        const raw = value[meta.readKey];
        if (raw == null) {
          continue;
        }
        let val = raw;
        if (meta.readKey === "percentage") {
          val = Math.round(raw);
        } else if (meta.readKey === "onOffState") {
          val = !!raw;
        }
        await this.setStateChangedAsync(base + "." + meta.stateName, { val: val, ack: true });
      }
    }
    const missing = this.ccDestinations.filter((dest) => !updated.has(dest.id)).map((dest) => dest.name);
    if (missing.length) {
      // The controller answered the poll but returned no data for these destinations
      // (e.g. an actuator that is asleep or out of radio range reports a status error).
      this.log.debug("commonCommand poll updated " + updated.size + " of " + this.ccDestinations.length + " destinations; no status for: " + missing.join(", "));
    } else {
      this.log.debug("commonCommand poll updated " + updated.size + " destinations");
    }
  }

  /**
   * One poll cycle: commonCommand mode when a tree was built (local preferred, cloud
   * fallback), otherwise the legacy cloud status poll.
   */
  async pollStatus() {
    if (this.polling) {
      // A previous poll is still running (it exceeded the interval); skip this tick so
      // local status requests cannot overlap and violate the throttle spacing.
      return;
    }
    this.polling = true;
    try {
      // Self-heal: when local access is configured but the tree could not be built yet
      // (controller was down at startup, dropped off the LAN, or an earlier scan missed it),
      // retry. maybeDiscoverLocal re-runs the scan when no host is known yet; otherwise
      // setupCommonCommand retries with the configured/cached host.
      if (!this.cc && this.wantsLocal) {
        await this.maybeDiscoverLocal();
        if (!this.cc) {
          await this.setupCommonCommand();
        }
      }
      if (this.cc) {
        this.ccActive = await this.cc.pingLocal();
        await this.pollCommonCommand();
        return;
      }
      if (this.aToken) {
        // Cloud fallback: keep the configured minute interval even though the loop may run
        // on the faster local cadence, so the intermittent cloud is not hammered.
        const cloudWaitMs = this.config.interval * 60 * 1000;
        if (Date.now() - this.lastCloudPollTs >= cloudWaitMs) {
          this.lastCloudPollTs = Date.now();
          await this.getDeviceStatus();
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Route a write on a local.* state to the commonCommand client.
   * @param {string} id
   * @param {string[]} idArray
   * @param {ioBroker.State} state
   */
  async handleCommonCommand(id, idArray, state) {
    if (!this.cc) {
      return;
    }
    if (idArray[3] === "scenes") {
      const scene = this.ccScenes.find((entry) => entry.name === idArray[4]);
      if (scene) {
        try {
          await this.cc.executeScene(scene.id);
        } catch (error) {
          this.log.error("Scene failed for " + scene.name + ": " + (error && error.message));
        }
        this.setState(id, false, true);
      }
      return;
    }
    const dest = this.ccDestinations.find((entry) => entry.name === idArray[3]);
    if (!dest) {
      return;
    }
    const stateName = idArray[idArray.length - 1];
    const meta = dest.actions.find((entry) => entry.stateName === stateName);
    if (!meta) {
      return;
    }
    let parameters = {};
    /** @type {number|boolean|null} */
    let ackVal = null;
    if (meta.kind === "level") {
      // Reject missing/blank values: Number(null), Number("") and Number("  ") are all 0,
      // which would drive to position 0 (fully close/move) instead of being ignored.
      if (state.val == null || (typeof state.val === "string" && state.val.trim() === "")) {
        return;
      }
      const value = Number(state.val);
      if (!Number.isFinite(value)) {
        return;
      }
      const clamped = Math.max(meta.clampMin, Math.min(meta.clampMax, value));
      parameters = { [meta.paramKey]: clamped };
      ackVal = clamped;
    } else if (meta.kind === "switch") {
      // Only act on a recognized boolean; a missing/unknown value must not switch equipment off.
      /** @type {boolean|null} */
      let on = null;
      if (state.val === true || state.val === 1 || state.val === "true" || state.val === "1") {
        on = true;
      } else if (state.val === false || state.val === 0 || state.val === "false" || state.val === "0") {
        on = false;
      }
      if (on === null) {
        return;
      }
      parameters = { [meta.paramKey]: on };
      ackVal = on;
    }
    // Buttons (stop/toggle/impulse/identify) carry no parameters.
    let ok = false;
    try {
      await this.cc.action([{ destinationId: dest.id, actionId: meta.id, parameters: parameters }]);
      ok = true;
    } catch (error) {
      this.log.error("Command failed for " + dest.name + " " + stateName + ": " + (error && error.message));
    }
    if (meta.kind === "button") {
      // Reset the momentary button regardless of outcome.
      this.setState(id, false, true);
    } else if (ok) {
      // Acknowledge the value actually sent, not the raw (possibly out-of-range) input.
      this.setState(id, ackVal, true);
    }
  }

  async genericPostMessage(action, parameter, retry = true) {
    if (!this.webControlId) {
      this.log.error("No webcontrol id found");
      return;
    }
    const url = this.messagingService + "/wcp/" + this.webControlId + "/postMessage/";
    const data = JSON.stringify({ action: action, parameters: parameter, changeIds: [] });
    this.log.debug("request: " + url);
    this.log.debug("data: " + data);
    // Reads may be retried on transient failures. Write commands (functionCode 3)
    // pass retry=false: retrying a POST after a timeout could re-send a command the
    // server already accepted.
    const doRequest = () =>
      this.requestClient({
        method: "post",
        url: url,
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          "user-agent": this.userAgent,
          "accept-language": "de-DE;q=1",
          authorization: "Bearer " + this.aToken,
        },
        data: { action: action, parameters: parameter, changeIds: [] },
      });
    return await (retry ? this.retryRequest(doRequest) : doRequest())
      .then((response) => {
        this.log.debug(JSON.stringify(response.data));
        return response.data;
      })
      .catch((error) => {
        if (!error) {
          return;
        }
        if (error.response && error.response.status === 401) {
          this.log.debug("error 401");
          this.refreshToken()
            .then(() => {
              this.log.info("Retry message in 1min");
              this.waitTimeout = setTimeout(() => {
                this.genericPostMessage(action, parameter, retry).catch(() => {
                  this.log.error("Failed to post after refresh token");
                });
              }, 1 * 60 * 1000);
            })
            .catch(() => {
              this.log.error("Failed to refresh token. Relogin");
              this.login().catch(() => {
                this.log.error("Failed to relogin");
              });
            });
          return;
        }
        // The controller intermittently drops off the Warema IoT hub; the cloud then
        // answers 400 with code 4001. This is transient, so log it quietly and let the
        // next poll cycle recover instead of dumping a full error stack every time.
        const body = error.response && JSON.stringify(error.response.data);
        if (error.response && error.response.status === 400 && body && body.indexOf("4001") !== -1) {
          this.log.debug("Device not connected to the iot hub (4001) for action " + action);
          return;
        }
        this.log.error("Request failed for action " + action + ": " + this.formatError(error));
      });
  }

  getCodeChallenge() {
    this.code_verifier = this.randomString(64);
    const base64Digest = crypto.createHash("sha256").update(this.code_verifier).digest("base64");
    const code_challenge = base64Digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    return [this.code_verifier, code_challenge];
  }

  randomString(length) {
    let result = "";
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }
  decimalToHex(d, padding) {
    let hex = Number(d).toString(16);
    padding = typeof padding === "undefined" || padding === null ? 2 : padding;

    while (hex.length < padding) {
      hex = "0" + hex;
    }

    return hex;
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.unloaded = true;
      this.setState("info.connection", false, true);
      this.cc && this.cc.stop();
      this.appUpdateInterval && clearInterval(this.appUpdateInterval);
      clearInterval(this.refreshTokenInterval);
      clearTimeout(this.waitTimeout);
      callback();
    } catch (e) {
      this.log.error("onUnload: " + e);
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      const idArray = id.split(".");
      const pre = idArray.slice(0, -1).join(".");
      if (!state.ack) {
        if (idArray[2] === "local") {
          await this.handleCommonCommand(id, idArray, state);
          return;
        }
        if (idArray[2] === "scenes") {
          const scene = this.sceneList.find((entry) => entry.name === idArray[3]);
          if (scene) {
            await this.genericPostMessage("executeScene", { sceneNumber: scene.id }, false);
            this.setState(id, false, true);
            return;
          }
        }
        if (idArray[2] === "channels") {
          const channel = this.channelList.find((entry) => entry.name === idArray[3]);
          if (channel) {
            const command = idArray[idArray.length - 1];
            const value = Number(state.val);
            let parameter;
            /** @type {number|null} */
            let ackVal = null;
            if (command === "stop") {
              parameter = { channel: channel.id, functionCode: 1 };
            } else if (command === "position" && Number.isFinite(value)) {
              const clamped = Math.max(0, Math.min(100, value));
              ackVal = clamped;
              parameter = { channel: channel.id, functionCode: 3, setting0: clamped * 2, setting1: 255, setting2: 255, setting3: 255 };
            } else if (command === "slatAngle" && Number.isFinite(value)) {
              const clamped = Math.max(-127, Math.min(127, value));
              ackVal = clamped;
              parameter = { channel: channel.id, functionCode: 3, setting0: 255, setting1: clamped + 127, setting2: 255, setting3: 255 };
            }
            if (parameter) {
              const result = await this.genericPostMessage("channelCommandRequest", parameter, false);
              // Reset the momentary stop button; only acknowledge position/angle once
              // the command was actually accepted (genericPostMessage resolves the
              // response on success, undefined on failure), and with the clamped value
              // that was actually sent, not the raw input.
              if (command === "stop") {
                this.setState(id, false, true);
              } else if (result != null) {
                this.setState(id, ackVal, true);
              }
            }
            return;
          }
        }
        if (id.indexOf(".setting") !== -1 && id.indexOf("Convert") === -1) {
          const serialNumber = await this.getStateAsync(pre + ".serialNumber");
          if (serialNumber) {
            this.setDeviceStatus({ id: serialNumber.val, name: idArray[2] }, idArray[idArray.length - 1], state.val).catch(() => {
              this.log.error("set status failed");
            });
          }
        }
        if (id.indexOf(".setting") !== -1 && id.indexOf("Convert") !== -1) {
          const trimmedID = id.replace("Convert", "");
          const index = trimmedID.slice(-1);
          const parameterState = await this.getStateAsync(pre + ".parameterType" + index);
          if (parameterState && state && state.val != null) {
            let value = state.val;
            if (parameterState.val === 55) {
              // No counterpart in app 3.9.6 and the scaling is unverified. Kept
              // unchanged for legacy devices that report parameterType 55; verify
              // against real hardware before touching the formula.
              value = this.decimalToHex(state.val / 2);
            }
            if (parameterState.val === 12) {
              value = state.val === 255 ? 255 : state.val * 2;
            }
            if (parameterState.val === 13) {
              value = state.val === 255 ? 255 : state.val + 127;
            }
            this.setState(trimmedID, value, false);
          }
        }
      } else {
        if (idArray[2] !== "scenes" && idArray[2] !== "channels" && id.indexOf(".setting") !== -1 && id.indexOf("Convert") === -1) {
          await this.setObjectNotExistsAsync(id + "Convert", {
            type: "state",
            common: {
              name: "Settings converted in readable value",
              role: "indicator",
              type: "mixed",
              write: true,
              read: true,
            },
            native: {},
          });
          const index = id.slice(-1);
          const parameterState = await this.getStateAsync(pre + ".parameterType" + index);
          if (parameterState) {
            let value = state.val;
            if (parameterState.val === 55) {
              // No counterpart in app 3.9.6 and the scaling is unverified. Kept
              // unchanged for legacy devices that report parameterType 55; verify
              // against real hardware before touching the formula.
              value = parseInt(state.val, 16) * 2;
            }
            if (parameterState.val === 12) {
              value = state.val === 255 || state.val == null ? 255 : Math.round(state.val / 2);
            }
            if (parameterState.val === 13) {
              value = state.val === 255 || state.val == null ? 255 : state.val - 127;
            }
            await this.setStateAsync(id + "Convert", value, true);
          } else {
            this.log.debug("No parameterType found: " + pre + ".parameterType" + index);
          }
        }
      }
    } else {
      // The state was deleted
    }
  }

  // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
  // /**
  //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
  //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
  //  * @param {ioBroker.Message} obj
  //  */
  // onMessage(obj) {
  //     if (typeof obj === "object" && obj.message) {
  //         if (obj.command === "send") {
  //             // e.g. send email or pushover or whatever
  //             this.log.info("send command");

  //             // Send response in callback if required
  //             if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
  //         }
  //     }
  // }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Wmswebcontrol(options);
} else {
  // otherwise start the instance directly
  new Wmswebcontrol();
}
