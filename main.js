"use strict";

/*
 * Created with @iobroker/create-adapter v1.33.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const axiosCookieJarSupport = require("axios-cookiejar-support").default;
const tough = require("tough-cookie");
const crypto = require("crypto");
const { extractKeys } = require("./lib/extractKeys");

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
        // this.on("objectChange", this.onObjectChange.bind(this));
        // this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        this.extractKeys = extractKeys;
        this.aToken = "";
        this.rToken = "";
        this.userAgent = "WMS WebControl pro/1.24.0 (iPhone; iOS 12.5.1; Scale/2.00)";
        this.appUpdateInterval = null;
        this.deviceIdArray = [];
        this.localUpdateIntervals = {};
        axiosCookieJarSupport(axios);
        this.cookieJar = new tough.CookieJar();

        this.deviceList = [];
        if (this.config.interval < 1) {
            this.config.interval = 1;
        }

        // in this template all states changes inside the adapters namespace are subscribed
        this.subscribeStates("*");
        this.login()
            .then(() => {
                this.setState("info.connection", true, true);
                this.log.info("Login successful");
                this.getDeviceInfo()
                    .then(() => {
                        this.getDeviceList()
                            .then(() => {
                                this.appUpdateInterval = setInterval(() => {
                                    this.getDeviceStatus().catch(() => {
                                        this.log.error("Get device status failed");
                                    });
                                }, this.config.interval * 60 * 1000);
                            })
                            .catch(() => {
                                this.log.error("Get device failed");
                            });
                    })
                    .catch(() => {
                        this.log.error("PostMessage failed");
                    });
            })
            .catch(() => {
                this.log.error("Login failed");
                this.setState("info.connection", false, true);
            });
    }

    login() {
        return new Promise(async (resolve, reject) => {
            const [code_verifier, codeChallenge] = this.getCodeChallenge();
            const nonce = this.randomString(50);
            const state = this.randomString(50);
            axios({
                method: "get",
                jar: this.cookieJar,
                withCredentials: true,
                url:
                    "https://auth.warema.de/v1/connect/authorize?redirect_uri=wcpmobileapp%3A%2F%2Fpages%2Fredirect&client_id=devicecloud_wcpmobileapp&response_type=code&grant_type=authorization_code&nonce=" +
                    nonce +
                    "&state=" +
                    state +
                    "&scope=openid%20profile%20offline_access%20devicecloud_devicecloudservice_devices_get%20devicecloud_devicecloudservice_devices_register%20devicecloud_devicecloudservice_devices_unregister%20devicecloud_devicecloudservice_commoncommand_action%20devicecloud_devicecloudservice_commoncommand_discovery%20devicecloud_devicecloudservice_commoncommand_ping%20devicecloud_devicecloudservice_commoncommand_scene%20devicecloud_devicecloudservice_commoncommand_status%20devicecloud_devicecloudservice_communication_systemnative&code_challenge=" +
                    codeChallenge +
                    "&code_challenge_method=S256",
                headers: {
                    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "accept-language": "de-de",
                },
            })
                .then((response) => {
                    const tokenA = response.data.split('RequestVerificationToken" type="hidden" value="');
                    const token = tokenA[1].split('" />')[0];
                    axios({
                        method: "post",
                        jar: this.cookieJar,
                        withCredentials: true,
                        url: "https://auth.warema.de" + response.request.path,
                        headers: {
                            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "content-type": "application/x-www-form-urlencoded",
                            "accept-language": "de-de",
                            "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                        },
                        data:
                            "Input.Username=" +
                            this.config.user +
                            "&Input.Password=" +
                            this.config.password +
                            "&Input.RememberMe=true&button=login&__RequestVerificationToken=" +
                            token +
                            "&Input.RememberMe=false",
                    })
                        .then((response) => {
                            const url = response.data.split("0;url=")[1].split('" data-url')[0].replace(/&amp;/g, "&");
                            axios({
                                method: "get",
                                jar: this.cookieJar,
                                withCredentials: true,
                                url: "https://auth.warema.de" + url,
                                headers: {
                                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                                    "accept-language": "de-de",
                                    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                                },
                            })
                                .then((response) => {
                                    reject();
                                })
                                .catch((error) => {
                                    const code = error.config.url.split("code=")[1].split("&scope")[0];
                                    this.log.debug("code: " + code);
                                    this.log.debug("code_verifier: " + code_verifier);
                                    this.log.debug("codeChallenge: " + codeChallenge);
                                    this.log.debug("state: " + state);
                                    this.log.debug("nonce: " + nonce);
                                    axios({
                                        method: "post",
                                        jar: this.cookieJar,
                                        withCredentials: true,
                                        url: "https://auth.warema.de/v1/connect/token",
                                        headers: {
                                            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                                            "content-type": "application/x-www-form-urlencoded",
                                            "accept-language": "de-de",
                                            "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                                        },
                                        data:
                                            "client_id=devicecloud_wcpmobileapp&client_secret=nosecret&code=" +
                                            code +
                                            "&code_verifier=" +
                                            code_verifier +
                                            "&grant_type=authorization_code&redirect_uri=wcpmobileapp%3A%2F%2Fpages%2Fredirect",
                                    })
                                        .then((response) => {
                                            this.log.debug(JSON.stringify(response.data));
                                            this.aToken = response.data.access_token;
                                            this.rToken = response.data.refresh_token;
                                            this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
                                            this.refreshTokenInterval = setInterval(() => {
                                                this.refreshToken().catch(() => {});
                                            }, 15 * 60 * 1000); // 15min
                                            resolve();
                                        })
                                        .catch((error) => {
                                            if (error.response.status === 400) {
                                                this.log.error("Login was not successful restart adapter");
                                                this.restart();
                                            }
                                            error.response && this.log.error(JSON.stringify(error.response.data));
                                            error.config && this.log.error(error.config.url);
                                            this.log.error(error);

                                            reject();
                                        });
                                });
                        })
                        .catch((error) => {
                            error.config && this.log.error(error.config.url);
                            error.response && this.log.error(JSON.stringify(error.response.data));
                            this.log.error(error);
                            reject();
                        });
                })
                .catch((error) => {
                    this.log.error(error);
                    this.log.error("First Login step failed.");
                });
        });
    }
    refreshToken() {
        return new Promise(async (resolve, reject) => {
            this.log.debug("refresh token");
            axios({
                method: "post",
                jar: this.cookieJar,
                withCredentials: true,
                url: "https://auth.warema.de/v1/connect/token",
                headers: {
                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "content-type": "application/x-www-form-urlencoded",
                    "accept-language": "de-de",
                    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                },
                data:
                    "client_id=devicecloud_wcpmobileapp&client_secret=nosecret&code_verifier=" +
                    this.code_verifier +
                    "&grant_type=refresh_token&redirect_uri=wcpmobileapp%3A%2F%2Fpages%2Fredirect&refresh_token=" +
                    this.rToken,
            })
                .then((response) => {
                    this.log.debug(JSON.stringify(response.data));
                    this.aToken = response.data.access_token;
                    this.rToken = response.data.refresh_token;

                    resolve();
                })
                .catch((error) => {
                    error.config && this.log.error(error.config.url);
                    this.log.error(error);
                    reject();
                });
        });
    }
    getDeviceInfo() {
        return new Promise(async (resolve, reject) => {
            this.log.debug("get devices");
            axios({
                method: "get",
                jar: this.cookieJar,
                withCredentials: true,
                url: "https://devicecloudservice.prod.devicecloud.warema.de/api/v1.0/devices",
                headers: {
                    accept: "*/*",
                    "content-type": "application/x-www-form-urlencoded",
                    "user-agent": this.userAgent,
                    "accept-language": "de-DE;q=1",
                    authorization: "Bearer " + this.aToken,
                },
            })
                .then((response) => {
                    this.log.debug(JSON.stringify(response.data));
                    if (response.data.result) {
                        this.extractKeys(this, "devices", response.data.result, false, "serialNumber");
                        this.webControlId = response.data.result[0].serialNumber;
                        this.wcType = response.data.result[0].type.toLowerCase();
                        axios({
                            method: "post",
                            jar: this.cookieJar,
                            withCredentials: true,
                            url: "https://devicecloudservice.prod.devicecloud.warema.de/api/v1.0/communication/" + this.wcType + "/" + this.webControlId + "/postMessage/",
                            headers: {
                                accept: "*/*",
                                "content-type": "application/json",
                                "user-agent": this.userAgent,
                                "accept-language": "de-DE;q=1",
                                authorization: "Bearer " + this.aToken,
                            },
                            data: JSON.stringify({ action: "info", changeIds: [] }),
                        })
                            .then((response) => {
                                this.log.debug(JSON.stringify(response.data));
                                if (response.data.response) {
                                    this.extractKeys(this, "devices." + this.webControlId, response.data.response);
                                }
                                resolve();
                            })
                            .catch((error) => {
                                error.config && this.log.error(error.config.url);
                                this.log.error(error);
                                reject();
                            });
                    }
                    resolve();
                })
                .catch((error) => {
                    error.config && this.log.error(error.config.url);
                    this.log.error(error);
                    reject();
                });
        });
    }
    getDeviceList() {
        return new Promise(async (resolve, reject) => {
            this.genericPostMessage("mb8Read", {
                address: 0,
                block: 42,
                eui: parseInt(this.webControlId),
                length: 12800,
            })
                .then((result) => {
                    this.log.debug(JSON.stringify(result.response));
                    result = Buffer.from(result.response.data, "base64");
                    const deviceArray = result.toString("hex").match(/(.{1,128})/g);
                    if (!deviceArray) {
                        this.log.error("No devices found");
                        reject();
                        return;
                    }
                    deviceArray.forEach(async (element) => {
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
                            .replace(/\u0000/g, "")
                            .replace(/ /g, "")
                            .replace(/\./g, "");
                        if (elementSerial != 0) {
                            this.deviceList.push({ id: elementSerial, name: elementName });
                            await this.setObjectNotExistsAsync(elementName, {
                                type: "device",
                                common: {
                                    name: elementSerial.toString(),
                                    role: "indicator",
                                    type: "mixed",
                                    write: false,
                                    read: true,
                                },
                                native: {},
                            });
                        }
                    });
                    resolve();
                    this.log.debug(JSON.stringify(this.deviceList));
                    this.getDeviceStatus().catch(() => {
                        this.log.error("Get device status failed");
                    });
                })
                .catch((error) => {
                    this.log.error("Get DevicesList failed");

                    error.response && this.log.error(JSON.stringify(error.response.data));
                    this.log.error(error);
                    reject();
                });
        });
    }
    getDeviceStatus() {
        return new Promise(async (resolve, reject) => {
            this.deviceList.forEach((element) => {
                this.genericPostMessage("manualCommandRequest", { serialNumber: element.id, functionCode: 0, setting0: 255, setting1: 255, setting2: 255, setting3: 255 })
                    .then((result) => {
                        this.log.debug(JSON.stringify(result.response));
                        this.extractKeys(this, element.name, result.response, true);
                        resolve();
                    })
                    .catch(() => {
                        this.log.error("Get device status failed");
                        reject();
                    });
            });
        });
    }
    setDeviceStatus(device, key, value) {
        return new Promise(async (resolve, reject) => {
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
            this.genericPostMessage("manualCommandRequest", data)
                .then((result) => {
                    this.log.debug(JSON.stringify(result.response));
                    // this.extractKeys(this, device.name, result.response, true);
                    this.waitTimeout = setTimeout(() => {
                        this.getDeviceStatus()
                            .then(() => {
                                this.waitTimeout = setTimeout(() => {
                                    this.getDeviceStatus().catch(() => {
                                        this.log.error("Get device status failed");
                                    });
                                }, 15000);
                            })
                            .catch(() => {
                                this.log.error("Get device status failed");
                            });
                    }, 5000);
                    resolve();
                })
                .catch(() => {
                    this.log.error("set status failed");
                    reject();
                });
        });
    }
    genericPostMessage(action, parameter) {
        return new Promise(async (resolve, reject) => {
            const url = "https://devicecloudservice.prod.devicecloud.warema.de/api/v1.0/communication/" + this.wcType + "/" + this.webControlId + "/postMessage/";
            const data = JSON.stringify({ action: action, parameters: parameter, changeIds: [] });
            this.log.debug(url);
            this.log.debug(data);
            axios({
                method: "post",
                jar: this.cookieJar,
                withCredentials: true,
                url: url,
                headers: {
                    accept: "*/*",
                    "content-type": "application/json",
                    "user-agent": this.userAgent,
                    "accept-language": "de-DE;q=1",
                    authorization: "Bearer " + this.aToken,
                },
                data: data,
            })
                .then((response) => {
                    this.log.debug(JSON.stringify(response.data));
                    resolve(response.data);
                    response.config && this.log.debug("Response:" + response.config.url);
                })
                .catch((error) => {
                    if (error.response.status === 401) {
                        this.log.debug("error 401");
                        this.refreshToken()
                            .then(() => {
                                this.log.info("Retry message in 1min");
                                this.waitTimeout = setTimeout(() => {
                                    this.genericPostMessage(action, parameter).catch(() => {
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
                    }
                    error.config && this.log.error(error.config.url);
                    this.log.error(error);
                    error.response && this.log.error(JSON.stringify(error.response.data));
                    reject();
                });
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
        padding = typeof padding === "undefined" || padding === null ? (padding = 2) : padding;

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
            clearInterval(this.appUpdateInterval);
            clearInterval(this.refreshTokenInterval);
            clearTimeout(this.waitTimeout);
            callback();
        } catch (e) {
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
                    let value = state.val;
                    if (parameterState.val === 55) {
                        value = this.decimalToHex(state.val / 2);
                    }
                    if (parameterState.val === 12) {
                        value = state.val * 2;
                    }
                    if (parameterState.val === 13) {
                        value = state.val + 127;
                    }
                    this.setState(trimmedID, value, false);
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
                    let value = state.val;
                    if (parameterState.val === 55) {
                        value = parseInt(state.val, 16) * 2;
                    }
                    if (parameterState.val === 12) {
                        value = state.val / 2;
                    }
                    if (parameterState.val === 13) {
                        value = state.val - 127;
                    }
                    this.setState(id + "Convert", value, true);
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
