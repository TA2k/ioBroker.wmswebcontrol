//v2.4 custom
async function extractKeys(adapter, path, element, write, preferedArrayName, forceIndex) {
    try {
        if (element === null || element === undefined) {
            adapter.log.debug("Cannot extract empty: " + path);
            return;
        }
        const objectKeys = Object.keys(element);
        write = write || false;
        if (Array.isArray(element)) {
            extractArray(adapter, element, "", path, write, preferedArrayName, forceIndex);
            return;
        }

        if (typeof element === "string") {
            adapter
                .setObjectNotExistsAsync(path, {
                    type: "state",
                    common: {
                        name: element,
                        role: "indicator",
                        type: typeof element,
                        write: write,
                        read: true,
                    },
                    native: {},
                })
                .then(() => {
                    adapter.setState(path, element, true);
                })
                .catch((error) => {
                    adapter.log.error(error);
                });
            return;
        }

        objectKeys.forEach((key) => {
            if (Array.isArray(element[key])) {
                extractArray(adapter, element, key, path, write, preferedArrayName, forceIndex);
            } else if (element[key] !== null && typeof element[key] === "object") {
                extractKeys(adapter, path + "." + key, element[key]);
            } else {
                adapter
                    .setObjectNotExistsAsync(path + "." + key, {
                        type: "state",
                        common: {
                            name: key,
                            role: "indicator",
                            type: typeof element[key],
                            write: write,
                            read: true,
                        },
                        native: {},
                    })
                    .then(() => {
                        if (key === "textIndexDrivingCause") {
                            adapter.extendObject(path + "." + key, {
                                type: "state",
                                common: {
                                    name: key,
                                    role: "indicator",
                                    type: typeof element[key],
                                    write: write,
                                    read: true,
                                    states: drivingCause,
                                },
                                native: {},
                            });
                        }
                        if (key === "textIndexFunctionCode") {
                            adapter.extendObject(path + "." + key, {
                                type: "state",
                                common: {
                                    name: key,
                                    role: "indicator",
                                    type: typeof element[key],
                                    write: write,
                                    read: true,
                                    states: functionCode,
                                },
                                native: {},
                            });
                        }
                        adapter.setState(path + "." + key, element[key], true);
                    })
                    .catch((error) => {
                        adapter.log.error(error);
                    });
            }
        });
    } catch (error) {
        adapter.log.error("Error extract keys: " + path + " " + JSON.stringify(element));
        adapter.log.error(error);
    }
}
function extractArray(adapter, element, key, path, write, preferedArrayName, forceIndex) {
    try {
        if (key) {
            element = element[key];
        }
        element.forEach(async (arrayElement, index) => {
            index = index + 1;
            if (index < 10) {
                index = "0" + index;
            }
            let arrayPath = key + index;

            if (typeof arrayElement[Object.keys(arrayElement)[0]] === "string") {
                arrayPath = arrayElement[Object.keys(arrayElement)[0]];
            }
            Object.keys(arrayElement).forEach((keyName) => {
                if (keyName.endsWith("Id")) {
                    if (arrayElement[keyName].replace) {
                        arrayPath = arrayElement[keyName].replace(/\./g, "");
                    } else {
                        arrayPath = arrayElement[keyName];
                    }
                }
            });
            Object.keys(arrayElement).forEach((keyName) => {
                if (keyName.endsWith("Name")) {
                    arrayPath = arrayElement[keyName];
                }
            });

            if (arrayElement.id) {
                if (arrayElement.id.replace) {
                    arrayPath = arrayElement.id.replace(/\./g, "");
                } else {
                    arrayPath = arrayElement.id;
                }
            }
            if (arrayElement.name) {
                arrayPath = arrayElement.name.replace(/\./g, "");
            }
            if (arrayElement.start_date_time) {
                arrayPath = arrayElement.start_date_time.replace(/\./g, "");
            }
            if (preferedArrayName && arrayElement[preferedArrayName]) {
                arrayPath = arrayElement[preferedArrayName].replace(/\./g, "");
            }

            if (forceIndex) {
                arrayPath = key + index;
            }
            //special case array with 2 string objects
            if (Object.keys(arrayElement).length === 2 && typeof Object.keys(arrayElement)[0] === "string" && typeof Object.keys(arrayElement)[1] === "string") {
                let subKey = arrayElement[Object.keys(arrayElement)[0]];
                const subValue = arrayElement[Object.keys(arrayElement)[1]];
                const subName = Object.keys(arrayElement)[0] + " " + Object.keys(arrayElement)[1];
                if (key) {
                    subKey = key + "." + subKey;
                }
                await adapter.setObjectNotExistsAsync(path + "." + subKey, {
                    type: "state",
                    common: {
                        name: subName,
                        role: "indicator",
                        type: typeof subValue,
                        write: write,
                        read: true,
                    },
                    native: {},
                });
                adapter.setState(path + "." + subKey, subValue, true);
                return;
            }
            extractKeys(adapter, path + "." + arrayPath, arrayElement);
        });
    } catch (error) {
        adapter.log.error("Cannot extract array " + path);
        adapter.log.error(error);
    }
}
const drivingCause = {
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
};
const functionCode = {
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
};

module.exports = {
    extractKeys,
};
