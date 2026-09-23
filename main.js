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
const Json2iob = require("json2iob");

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
    this.appUpdateInterval = null;
    // Number of consecutive status polls that returned no data. info.connection is
    // only flipped to false after several failures so a single transient hiccup
    // does not flatter the connection indicator.
    this.failedStatusCycles = 0;

    this.deviceList = [];
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
    if (!this.config.user || !this.config.password) {
      this.log.info("Please enter your username and password!");
      return;
    }
    // in this template all states changes inside the adapters namespace are subscribed
    this.subscribeStates("*");
    await this.login();
    if (this.aToken) {
      await this.sleep(1000);
      await this.getServiceMap();
      await this.getDeviceInfo();

      await this.getDeviceList();
      await this.sleep(5000);
      await this.getDeviceStatus();
      this.appUpdateInterval = setInterval(async () => {
        await this.getDeviceStatus();
      }, this.config.interval * 60 * 1000);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken().catch(() => {});
      }, 15 * 60 * 1000); // 15min
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
      error.response && this.log.error(JSON.stringify(error.response.data));
      this.log.error(String(error));
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
      error.response && this.log.error(JSON.stringify(error.response.data));
      this.log.error(String(error));
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
      this.log.error(String(error));
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
        if (error.response && error.response.status === 400) {
          this.log.error("Login was not successful restart adapter");
          await this.sleep(10000);
          this.restart();
        }
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error(String(error));
      });
  }
  async sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
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
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error(String(error));
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
              this.log.error(String(error));
            });
        }
      })
      .catch((error) => {
        this.log.error(String(error));
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
      })
      .catch((error) => {
        this.log.error("Discovery failed, using default endpoints");
        this.log.error(String(error));
      });
  }
  async getDeviceList() {
    const resultData = await this.genericPostMessage("mb8Read", {
      address: 0,
      block: 42,
      eui: parseInt(this.webControlId),
      length: 12800,
    }).catch((error) => {
      this.log.error("Get DevicesList failed");
      if (error) {
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error(String(error));
      }
    });

    if (!resultData || !resultData.response || resultData.response.data == null) {
      this.log.error("Get DevicesList failed");
      return;
    }
    this.log.debug(JSON.stringify(resultData.response));
    const result = Buffer.from(resultData.response.data, "base64");
    const deviceArray = result.toString("hex").match(/(.{1,128})/g);
    if (!deviceArray) {
      this.log.error("No devices found");

      return;
    }
    for (const element of deviceArray) {
      let elementArray = element.split("ffffffffffff");
      if (!elementArray[1]) {
        elementArray = element.split("ffffff");
      }
      if (!elementArray[1]) {
        this.log.debug("Skip: " + element);
        return;
      }
      const elementSerial = Buffer.from(elementArray[0].substring(0, 8), "hex").readInt32LE();

      const elementName = Buffer.from(elementArray[1], "hex")
        .toString("latin1")
        //eslint-disable-next-line
        .replace(/\u0000/g, "")
        .replace(/ /g, "")
        .replace(/\./g, "");
      if (elementSerial != 0) {
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
      eui: 1278808,
      month: new Date().getMonth() + 1,
      sensorId: 255,
      year: parseInt(new Date().getFullYear().toString().substring(2)),
    }).catch((error) => {
      this.log.debug("No Sensor data");
      if (error) {
        error.response && this.log.debug(JSON.stringify(error.response.data));
        this.log.debug(String(error));
      }
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
        this.log.error(error);
        this.log.error("set status failed");
      });
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
          this.log.debug("Device not connected to the iot hub (4001)");
          return;
        }
        this.log.error(String(error));
        error.response && this.log.error(JSON.stringify(error.response.data));
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
      this.setState("info.connection", false, true);
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
        if (id.indexOf(".setting") !== -1 && id.indexOf("Convert") === -1) {
          const serialNumber = await this.getStateAsync(pre + ".serialNumber");
          this.setDeviceStatus({ id: serialNumber.val, name: idArray[2] }, idArray[idArray.length - 1], state.val).catch(() => {
            this.log.error("set status failed");
          });
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
        if (id.indexOf(".setting") !== -1 && id.indexOf("Convert") === -1) {
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
