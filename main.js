"use strict";

/*
 * Created with @iobroker/create-adapter v1.33.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const crypto = require("crypto");

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
        this.authToken = "";
        this.refreshToken = "";
        this.userAgent = "WMS WebControl pro/1.24.0 (iPhone; iOS 12.5.1; Scale/2.00)";
        this.appUpdateInterval = null;
        this.deviceIdArray = [];
        this.localUpdateIntervals = {};

        // in this template all states changes inside the adapters namespace are subscribed
        this.subscribeStates("*");
        this.login()
            .then(() => {
                this.setState("info.connection", true, true);
                this.getDeviceList()
                    .then(() => {
                        this.appUpdateInterval = setInterval(() => {
                            // this.getDeviceList();
                        }, this.config.interval * 60 * 1000);
                    })
                    .catch(() => {
                        this.log.error("Get Devices failed");
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

            axios({
                method: "get",
                url:
                    "https://auth.warema.de/v1/connect/authorize?redirect_uri=wcpmobileapp%3A%2F%2Fpages%2Fredirect&client_id=devicecloud_wcpmobileapp&response_type=code&grant_type=authorization_code&nonce=" +
                    this.randomString(50) +
                    "&state=" +
                    this.randomString(50) +
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
                    try {
                        if ((response.data && response.data.status === "error") || response.status >= 400 ) {
                            this.log.error(response.status);
                            this.log.error(response.config.url);
                            this.log.error(JSON.stringify(response.data));
                            reject();
                            return;
                        }
                        this.authToken = response.data.authToken;
                        resolve();
                        this.log.debug(JSON.stringify(response.data));
                        return;
                    } catch (e) {
                        this.log.error(e);
                        reject();
                    }
                })
                .catch((error) => {
                    this.log.error(error.config.url);
                    this.log.error(error);
                    reject();
                });
        });
    }
    getCodeChallenge() {
        const code_verifier = this.randomString(64);
        const base64Digest = crypto.createHash("sha256").update(code_verifier).digest("base64");

        const code_challenge = base64Digest.replace("+", "-").replace("/", "_").replace(/=+$/, "");
        return [code_verifier, code_challenge];
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

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);

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
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
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
