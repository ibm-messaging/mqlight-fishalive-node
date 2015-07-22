/*
 * Copyright (c) 2014 IBM Corporation and other Contributors.
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v1.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v10.html
 *
 * Contributors:
 * IBM - Initial Contribution
 */
/* jslint node: true */
/* jshint -W033,-W083,-W097 */

var PUBLISH_TOPIC = 'mqlight/sample/words'

var SUBSCRIBE_TOPIC = 'mqlight/sample/wordsuppercase'

var mqlightServiceName = 'mqlight'

var http = require('http')
var express = require('express')
var fs = require('fs')
var mqlight = require('mqlight')
var bodyParser = require('body-parser')
var uuid = require('node-uuid')

/*
 * Establish MQ credentials
 */
var opts = {}
var mqlightService = {}
if (process.env.VCAP_SERVICES) {
  var services = JSON.parse(process.env.VCAP_SERVICES)
  console.log('Running BlueMix')
  if (services[mqlightServiceName] === null) {
    throw Error('Error - Check that app is bound to service')
  }
  mqlightService = services[mqlightServiceName][0]
  opts.service = mqlightService.credentials.nonTLSConnectionLookupURI
  opts.user = mqlightService.credentials.username
  opts.password = mqlightService.credentials.password
} else {
  var fishaliveHost = process.env.FISHALIVE_HOST || 'localhost'
  opts.service = 'amqp://' + fishaliveHost + ':5672'
}
opts.id = 'NODE_FRONTEND_' + uuid.v4().substring(0, 7)

/*
 * Establish HTTP credentials, then configure Express
 */
var httpOpts = {}
httpOpts.port = (process.env.VCAP_APP_PORT || 3000)

var app = express()

/*
 * Create our MQ Light client
 * If we are not running in Bluemix, then default to a local MQ Light
 * connection
 */
var mqlightSubInitialised = false
var mqlightClient = mqlight.createClient(opts, function (err) {
  if (err) {
    console.error('Connection to ' + opts.service + ' using client-id ' +
      mqlightClient.id + ' failed: ' + err)
  } else {
    console.log('Connected to ' + opts.service + ' using client-id ' +
      mqlightClient.id)
  }
  /*
   * Create our subscription
   */
  mqlightClient.on('message', processMessage)
  var subOpts = {credit: 1, autoConfirm: false, qos: 1}
  mqlightClient.subscribe(SUBSCRIBE_TOPIC, subOpts, function (err) {
    if (err) {
      console.error('Failed to subscribe: ' + err)
    } else {
      console.log('Subscribed')
      mqlightSubInitialised = true
    }
  })
})

mqlightClient.on('error', function (err) {
  console.error(err)
})

/*
 * Store a maximum of one message from the MQ Light server, for the browser to
 * poll.  The polling GET REST handler does the confirm
 */
var heldMsg
function processMessage (data, delivery) {
  try {
    data = JSON.parse(data)
    console.log('Received response: ' + JSON.stringify(data))
  } catch (e) {
    // Expected if we're receiving a Javascript object
  }
  heldMsg = {'data': data, 'delivery': delivery}
}

/*
 * Add static HTTP content handling
 */
function staticContentHandler (req, res) {
  var url = 'web/' + req.url.substr(1)
  if (url === 'web/') { url = __dirname + '/web/index.html' }
  if (url === 'web/style.css') { res.contentType('text/css') }
  fs.readFile(url,
    function (err, data) {
      if (err) {
        res.writeHead(404)
        return res.end('Not found')
      }
      res.writeHead(200)
      return res.end(data)
    })
}
app.all('/', staticContentHandler)
app.all('/*.html', staticContentHandler)
app.all('/*.css', staticContentHandler)
app.all('/images/*', staticContentHandler)

/*
 * Use JSON for our REST payloads
 */
app.use(bodyParser.json())

/*
 * POST handler to publish words to our topic
 */
app.post('/rest/words', function (req, res) {
  // Check we've initialised our subscription
  if (!mqlightSubInitialised) {
    res.writeHead(500)
    return res.end('Connection to MQ Light not initialised')
  }

  // Check they've sent { "words" : "Some Sentence" }
  if (!req.body.words) {
    res.writeHead(500)
    return res.end('No words')
  }
  // Split it up into words
  var msgCount = 0
  req.body.words.split(' ').forEach(function (word) {
    // Send it as a message
    var msgData = {
      'word': word,
      'frontend': 'Node.js: ' + mqlightClient.id
    }
    console.log('Sending message: ' + JSON.stringify(msgData))
    mqlightClient.send(PUBLISH_TOPIC, msgData)
    msgCount++
  })
  // Send back a count of messages sent
  res.json({'msgCount': msgCount})
})

/*
 * GET handler to poll for notifications
 */
app.get('/rest/wordsuppercase', function (req, res) {
  // Do we have a message held?
  var msg = heldMsg
  if (msg) {
    // Let the next message stream down from MQ Light
    heldMsg = null
    msg.delivery.message.confirmDelivery()
    // Send the data to the caller
    res.json(msg.data)
  } else {
    // Just return no-data
    res.writeHead(204)
    res.end()
  }
})

/*
 * Start our REST server
 */
if (httpOpts.host) {
  http.createServer(app).listen(httpOpts.host, httpOpts.port, function () {
    console.log('App listening on ' + httpOpts.host + ':' + httpOpts.port)
  })
} else {
  http.createServer(app).listen(httpOpts.port, function () {
    console.log('App listening on *:' + httpOpts.port)
  })
}
