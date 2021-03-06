const SprutHubHelper = require('../lib/SprutHubHelper.js');
var mqtt = require('mqtt');

module.exports = function(RED) {
    class SprutHubNodeOut {
        constructor(config) {
            RED.nodes.createNode(this, config);

            var node = this;
            node.config = config;
            node.cleanTimer = null;
            node.server = RED.nodes.getNode(node.config.server);

            node.serviceType = undefined;


            if (typeof(node.config.uid) != 'object' || !(node.config.uid).length) {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "node-red-contrib-spruthub/server:status.no_accessory"
                });
            // } else if (!node.config.cid || node.config.cid === "0") {
            //     node.status({
            //         fill: "red",
            //         shape: "dot",
            //         text: "node-red-contrib-spruthub/server:status.no_characteristic"
            //     });
            } else if (node.server)  {
                node.on('input', function (message) {
                    node.processInput(message);
                });
            } else {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "node-red-contrib-spruthub/server:status.no_server"
                });
            }
        }

        processInput(message) {
            var node = this;
            clearTimeout(node.cleanTimer);

            var payload;
            switch (node.config.payloadType) {
                case 'flow':
                case 'global': {
                    RED.util.evaluateNodeProperty(node.config.payload, node.config.payloadType, this, message, function (error, result) {
                        if (error) {
                            node.error(error, message);
                        } else {
                            payload = result;
                        }
                    });
                    break;
                }
                case 'num': {
                    payload = parseInt(node.config.payload);
                    break;
                }

                case 'str': {
                    payload = node.config.payload;
                    break;
                }

                case 'bool': {
                    payload = node.config.payload?"true":"false";
                    break;
                }

                case 'json': {
                    if (SprutHubHelper.isJson(node.config.payload)) {
                        payload = JSON.parse(node.config.payload);
                    } else {
                        node.warn('Incorrect payload. Waiting for valid JSON');
                        node.status({
                            fill: "red",
                            shape: "dot",
                            text: "node-red-contrib-spruthub/out:status.no_payload"
                        });
                        node.cleanTimer = setTimeout(function () {
                            node.status({}); //clean
                        }, 3000);
                    }
                    break;
                }

                case 'msg':
                default: {
                    payload = message[node.config.payload];
                    break;
                }
            }


            node.cleanTimer = setTimeout(function () {
                node.status({}); //clean
            }, 3000);

            //validate payload
            if (payload === null || payload === undefined) {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "node-red-contrib-spruthub/out:status.no_payload"
                });
                return false;
            }

            for (var i in node.config.uid) {
                var uid = node.config.uid[i];


                var meta = null;
                var topic = '';
                if (typeof(payload) == 'object') {
                    var sentCnt = 0;
                    for (var cid in payload) {
                        meta = node.getServiceType(uid, cid);
                        if (meta['service'] !== undefined && meta['characteristic'] !== undefined) {
                            topic = node.server.getBaseTopic() + '/accessories/' + uid.split('_').join('/') + '/' + meta['service']['type'] + '/' + meta['characteristic']['type'] + '/set';
                            node.log('Published to mqtt topic: ' + topic + ' : ' + payload[cid] + "");
                            node.server.mqtt.publish(topic, payload[cid] + "");
                            sentCnt++;
                        } else {
                            node.warn('Check you payload. No such characteristic: '+cid);
                        }
                    }
                    if (!sentCnt) {
                        node.status({
                            fill: "red",
                            shape: "dot",
                            text: "node-red-contrib-spruthub/server:status.no_characteristic"
                        });
                        return false;
                    }
                } else {
                    if (!node.config.cid || node.config.cid === "0") {
                        node.status({
                            fill: "red",
                            shape: "dot",
                            text: "node-red-contrib-spruthub/server:status.no_characteristic"
                        });
                        return false;
                    }
                    meta = node.getServiceType(uid, node.config.cid);
                    topic = node.server.getBaseTopic() + '/accessories/' + uid.split('_').join('/') + '/' + meta['service']['type'] + '/' + meta['characteristic']['type'] + '/set';
                    node.log('Published to mqtt topic: ' + topic + ' : ' + payload+"");
                    node.server.mqtt.publish(topic, payload+"");
                }
            }

            node.status({
                fill: "green",
                shape: "dot",
                text: typeof(payload) == 'object'?"node-red-contrib-spruthub/server:status.sent":payload
            });
        }


        getServiceType(uid, cid) {
            var node = this;
            // if (node.serviceType !== undefined) {
            //     return node.serviceType;
            // } else {
                return node.server.getServiceType(uid, cid);
            // }
        }
    }


    RED.nodes.registerType('spruthub-out', SprutHubNodeOut);
};






