const SprutHubHelper = require('../lib/SprutHubHelper.js');
var mqtt = require('mqtt');
var request = require('request');

module.exports = function (RED) {
    class ServerNode {

        constructor(n) {
            RED.nodes.createNode(this, n);

            var node = this;
            node.config = n;
            node.connection = false;
            node.base_topic = "/spruthub";
            node.spruthub_port = 55555;
            node.spruthub_token = null;
            node.mqtt_port = 44444;
            node.topic = node.config.base_topic + '/#';
            node.accessories = undefined;
            node.service_types = undefined;
            node.items = undefined;
            node.devices = undefined;
            node.current_values = {};
            node.bridge_config = null;
            node.bridge_state = null;
            node.connectionTimer = null;
            node.connectionTimerFlag = false;
            node.on('close', () => this.onClose());
            node.setMaxListeners(0);

            node.init();
        }

        async init() {
            var node = this;


            await this.getToken().catch(error => {
                console.log(error);
                node.emit('onConnectError');
                node.log("Waiting for Sprut.hub, reconnecting in 10 seconds...");
                setTimeout(function () {
                    node.init();
                }, 10000);
                return false;
            });

            if (!node.spruthub_token) return;

            node.log('Sprut.hub initialized!')
            await this.getAccessories().catch(error => {
                console.log(error);
            });
            await this.getServiceTypes().catch(error => {
                console.log(error);
            });

            this.mqtt = this.connectMQTT();
            this.mqtt.on('connect', () => this.onMQTTConnect());
            this.mqtt.on('message', (topic, message) => this.onMQTTMessage(topic, message));
            this.mqtt.on('close', () => this.onMQTTClose());
            this.mqtt.on('end', () => this.onMQTTEnd());
            this.mqtt.on('reconnect', () => this.onMQTTReconnect());
            this.mqtt.on('offline', () => this.onMQTTOffline());
            this.mqtt.on('disconnect', (error) => this.onMQTTDisconnect(error));
            this.mqtt.on('error', (error) => this.onMQTTError(error));
        }

        getBaseTopic() {
            return this.base_topic;
        }

        connectMQTT(clientId = null) {
            var node = this;
            var options = {
                port: node.mqtt_port,
                username: node.config.mqtt_username || null,
                password: node.config.mqtt_password || null,
                clientId: "NodeRed-" + node.id + (clientId ? "-" + clientId : ""),
                connectTimeout: 3000,
                reconnectPeriod: 3000
            };
            return mqtt.connect('mqtt://' + node.config.host, options);
        }

        subscribeMQTT() {
            var node = this;
            node.mqtt.subscribe(node.getBaseTopic() + '/accessories/#', function (err) {
                if (err) {
                    node.warn('MQTT Error: Subscribe to "' + node.getBaseTopic() + '/accessories/#');
                    node.emit('onConnectError', err);
                } else {
                    node.log('MQTT Subscribed to: "' + node.getBaseTopic() + '/accessories/#');
                }
            })
        }

        unsubscribeMQTT() {
            var node = this;
            node.log('MQTT Unsubscribe from mqtt topic: ' + node.topic);
            node.mqtt.unsubscribe(node.topic, function (err) {
            });
            node.devices_values = [];
        }

        getToken() {
            var node = this;

            return new Promise(function (resolve, reject) {
                if (!node.hasOwnProperty("credentials") || !node.credentials.hasOwnProperty("api_password")) {
                    reject({errorMessage: "Empty credentials"});
                }
                var authUrl = "http://" + node.config.host + ":" + node.spruthub_port + "/api/server/login/" + encodeURIComponent(node.credentials.api_email);
                var formData = node.credentials.api_password;

                request({
                    headers: {
                        'Content-Length': formData.length,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    uri: authUrl,
                    body: formData,
                    method: 'POST'
                }, function (err, res, body) {
                    if (err) {
                        reject({errorMessage: err});
                    } else if (res.statusCode != 200) {
                        reject({
                            errorMessage: res.statusCode + " " + res.statusMessage + ": " + body,
                            statusCode: res.statusCode,
                            statusMessage: res.statusMessage,
                            body: body
                        });
                    } else {
                        if ('set-cookie' in res.headers) {
                            var rawCookie = res.headers['set-cookie'];
                            var regex = /token=([^;]*);/;
                            node.spruthub_token = regex.exec(rawCookie)[1];
                            if (node.spruthub_token) {
                                node.connection = true;
                                resolve(node.spruthub_token);
                            } else {
                                reject({errorMessage: "Sprut.hub: Token not found"});
                            }
                        } else {
                            reject({errorMessage: "Cookie was not set"});
                        }
                    }
                });
            });
        }

        async getAccessories(force = false) {
            var node = this;

            var data = await node.getApiCall('/api/homekit/json').catch(error => {
                node.warn(error);
                return (error);
            });
            if (SprutHubHelper.isJson(data)) {
                node.accessories = JSON.parse(data);
                node.saveCurrentValues(node.accessories);
                return node.accessories;
            }
        }

        async getServiceTypes() {
            var node = this;

            var data = await node.getApiCall('/api/types/service').catch(error => {
                node.warn(error);
                return (error);
            });
            if (SprutHubHelper.isJson(data)) {
                return node.service_types = JSON.parse(data);
            }
        }

        getApiCall(path) {
            var node = this;
            return new Promise(function (resolve, reject) {

                if (!node.spruthub_token) {
                    reject({errorMessage: "Sprut.hub: Token was not fetch"});
                }

                var url = "http://" + node.config.host + ":" + node.spruthub_port + path;

                request({
                    headers: {
                        'Cookie': 'token=' + node.spruthub_token
                    },
                    uri: url,
                    method: 'GET'
                }, function (err, res, body) {
                    if (err) {
                        reject({errorMessage: err});
                    } else if (res.statusCode != 200) {
                        reject({
                            errorMessage: res.statusCode + " " + res.statusMessage + ": " + body,
                            statusCode: res.statusCode,
                            statusMessage: res.statusMessage,
                            body: body
                        });
                    } else {
                        resolve(body);
                    }
                });
            });
        }

        testMqtt() {
            var node = this;

            return new Promise(function (resolve, reject) {
                var timeout = null;
                var client = node.connectMQTT('test');
                client.on('connect', function () {
                    client.subscribe(node.getBaseTopic() + "/revision", function (err) {
                        if (err) {
                            client.end(true);
                            reject({"errorMessage": err});
                        } else {
                            //end function after timeout, if now response
                            timeout = setTimeout(function () {
                                client.end(true);
                                reject({"errorMessage": "MQTT connect timeout"});
                            }, 3000);
                        }
                    })
                });
                client.on('message', function (topic, message) {
                    if (node.getBaseTopic() + "/revision" == topic) {
                        clearTimeout(timeout);
                        client.end(true);
                        resolve({"revision": message.toString()});
                    }
                });
                client.on('error', function (error) {
                    client.end(true);
                    reject({"errorMessage": error});
                });
            });
        }


        async checkConnection(config) {
            var node = this;
            node.config.host = config.host;
            node.config.email = node.credentials.api_email;
            node.config.password = node.credentials.api_password;
            // node.config.mqtt_username = config.mqtt_username;
            // node.config.mqtt_password = config.mqtt_password;

            var result = {
                "auth": false,
                "accessories_cnt": false,
                "version": false,
                "mqtt": false

            };

            var token = await node.getToken().catch(error => {
                node.warn(error);
            });
            if (token) {
                result['auth'] = true;
            }

            var accessories = await node.getAccessories().catch(error => {
                node.warn(error);
            });
            if (accessories) {
                result['accessories_cnt'] = Object.keys(accessories.accessories).length;
            }

            var version = await node.getApiCall('/api/server/version').catch(error => {
                node.warn(error);
            });
            if (version) {
                result['version'] = version;
            }

            var mqtt = await node.testMqtt().catch(error => {
                node.warn(error);
            });
            if (mqtt) {
                result['mqtt'] = true;
                result['mqtt_data'] = mqtt;
            }

            return result;
        }


        saveCurrentValues(data) {
            var node = this;

            var values = {};
            var key = null;
            var val = null;
            var characteristic = null;
            for (var i in data.accessories) {
                for (var i2 in data.accessories[i]['services']) {
                    for (var i3 in data.accessories[i]['services'][i2]['characteristics']) {
                        key = data.accessories[i]['aid'] + '_' + data.accessories[i]['services'][i2]['iid'];
                        characteristic = data.accessories[i]['services'][i2]['characteristics'][i3]['type'];
                        val = data.accessories[i]['services'][i2]['characteristics'][i3]['value'];

                        if (!(key in values)) values[key] = {};
                        values[key][characteristic] = val;
                    }
                }
            }

            node.current_values = values;
        }

        getServiceType(uid, cid = null) {
            var node = this;

            if (!node.accessories || !("accessories" in node.accessories)) return {};

            var uidRaw = uid.split('_');
            var aid = uidRaw[0];
            var sid = uidRaw[1];
            cid = cid != '0' ? cid : false;

            var res = {};
            loop1:
                for (var i in node.accessories.accessories) {
                    if (node.accessories.accessories[i]['aid'] == aid) {
                        loop2:
                            for (var i2 in node.accessories.accessories[i]['services']) {
                                if (node.accessories.accessories[i]['services'][i2]['iid'] == sid) {
                                    if (cid) {
                                        for (var i3 in node.accessories.accessories[i]['services'][i2]['characteristics']) {
                                            if (node.accessories.accessories[i]['services'][i2]['characteristics'][i3]['type'] == cid) {
                                                res['service'] = node.accessories.accessories[i]['services'][i2];
                                                res['characteristic'] = node.accessories.accessories[i]['services'][i2]['characteristics'][i3];
                                                break loop1;
                                            }
                                        }
                                    } else {
                                        res['service'] = node.accessories.accessories[i]['services'][i2];
                                        break loop1;
                                    }
                                }
                            }
                    }
                }

            if (!cid) {
                return res;
            }


            var serviceType = {};
            loop1:
                for (var i in node.service_types) {
                    if (res['service'] == node.service_types[i]['name']) {
                        loop2:
                            for (var i2 in node.service_types[i]['required']) {
                                if (node.service_types[i]['required'][i2]['name'] == res['characteristic']) {
                                    serviceType = node.service_types[i]['required'][i2];
                                    break loop1;
                                }
                                if (node.service_types[i]['optional'][i2]['name'] == res['characteristic']) {
                                    serviceType = node.service_types[i]['optional'][i2];
                                    break loop1;
                                }
                            }

                    }
                }
            serviceType['service'] = res['service'];
            serviceType['characteristic'] = res['characteristic'];

            return serviceType;
        }


        async onMQTTConnect() {
            var node = this;

            node.subscribeMQTT();

            node.log('MQTT Connected');
            node.emit('onMQTTConnect');
        }

        onMQTTDisconnect(error) {
            var node = this;
            // node.connection = true;
            node.log('MQTT Disconnected');
            console.log(error);

        }

        onMQTTError(error) {
            var node = this;
            // node.connection = true;
            node.log('MQTT Error');
            console.log(error);

        }

        onMQTTOffline() {
            var node = this;
            // node.connection = true;
            node.log('MQTT Offline');
            // console.log("MQTT OFFLINE");

        }

        onMQTTEnd() {
            var node = this;
            // node.connection = true;
            node.log('MQTT End');
            // console.log();

        }

        onMQTTReconnect() {
            var node = this;
            // node.connection = true;
            node.log('MQTT Reconnect');
            // console.log();

        }

        onMQTTClose() {
            var node = this;
            // node.connection = true;
            node.log('MQTT Close');
            node.emit('onConnectError');
            // console.log(node.connection);

        }

        onMQTTMessage(topic, message) {
            var node = this;

            var messageString = message.toString();

            //isSet
            if (topic.substring(topic.length - 4, topic.length) != '/set') {

                var parts = topic.split('/')
                if (parts[2] == 'accessories') {
                    var uid = parts[3] + '_' + parts[4];
                    if (!(uid in node.current_values)) node.current_values[uid] = {};

                    var value = SprutHubHelper.convertVarType(messageString);
                    node.current_values[uid][parts[6]] = value;

                    node.emit('onMQTTMessage', {
                        uid: uid
                    });
                }

            }
        }

        onClose() {
            var node = this;
            node.unsubscribeMQTT();
            node.mqtt.end();
            node.connection = false;
            node.emit('onClose');
            node.log('MQTT connection closed');
        }
    }

    RED.nodes.registerType('spruthub-server', ServerNode, {
        credentials: {
            api_email: {type: "text"},
            api_password: {type: "text"}
        }
    });
};

