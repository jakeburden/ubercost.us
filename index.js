require('env2')('.env')

var google = require('googleapis')
var isMoney = require('is-money-usd')
var Hapi = require('hapi')
var boom = require('boom')

var plugins = [
  require('hapi-auth-cookie'),
  require('bell'),
  require('vision'),
  require('inert')
]

var scopes = [
  'https://www.googleapis.com/auth/plus.profile.emails.read',
  'https://www.googleapis.com/auth/gmail.readonly'
]

var OAuth2 = google.auth.OAuth2
var gmail = google.gmail('v1')
var oauth2Client = new OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:9090/googleauth'
)
google.options({
  auth: oauth2Client
})

var server = new Hapi.Server()

server.connection({
  host: 'localhost',
  port: 9090
})

server.register(plugins, function (err) {
  if (err) return console.error(err)

  server.auth.strategy('session', 'cookie', {
    isSecure: false,
    password: 'secret_cookie_encryption_password'
  })

  server.auth.strategy('google', 'bell', {
    provider: 'google',
    password: process.env.PASSWORD,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    location: process.env.BASE_URL,
    isSecure: false,
    scope: scopes
  })

  server.auth.default('session')

  server.views({
    engines: {
      html: require('handlebars')
    },
    relativeTo: __dirname,
    path: 'views/partials',
    layoutPath: 'views/layout',
    layout: 'default'
  })

  server.route({
    method: 'GET',
    path: '/',
    config: {
      auth: {
        mode: 'optional'
      },
      handler: function (request, reply) {
        if (request.auth.isAuthenticated) {
          reply.view('authenticated/index', {
            name: request.auth.credentials.displayName
          })
        } else {
          reply.view('index')
        }
      }
    }
  })

  server.route({
    method: 'GET',
    path: '/{param*}',
    handler: {
      directory: {
        path: 'public',
        listing: true
      }
    }
  })

  server.route({
    method: 'GET',
    path: '/googleauth',
    config: {
      auth: 'google',
      handler: function (request, reply) {

        if (!request.auth.isAuthenticated) {
          return reply(boom.unauthorized('Authentication failed due to: ' + request.auth.error.message))
        }

        var creds = request.auth.credentials
        var profile = creds.profile
        var token = creds.token // in future refresh_token too?

        request.cookieAuth.set({
          googleId: profile.id,
          name: profile.name,
          displayName: profile.displayName,
          tokens: {
            access_token: token
          }
        })

        return reply.redirect('/')
      }
    }
  })

  server.route({
    method: 'GET',
    path: '/total',
    handler: function (request, reply) {
      var user = request.auth.credentials
      var tokens = user.tokens

      user.messagesRemaining = 0
      user.prices = []

      oauth2Client.credentials = tokens

      gmail.users.messages.list({
        auth: oauth2Client,
        userId: user.googleId,
        q: 'from:uber.us@uber.com'
      }, getMessages(request, reply, user))
    }
  })

  server.route({
    method: 'GET',
    path: '/about',
    config: {
      auth: {
        mode: 'optional'
      },
      handler: function (request, reply) {
        reply.view('about')
      }
    }
  })

  server.route({
    method: 'GET',
    path: '/logout',
    config: {
      auth: {
        mode: 'optional'
      },
      handler: function (request, reply) {
        request.cookieAuth.clear()
        return reply.redirect('/')
      }
    }
  })

  server.start(function (err) {
    if (err) throw err
    console.log('Server is running at:', server.info.uri)
  })
})

function getMessages (request, reply, user) {
  return function (err, response) {
    if (err) return reply(err)
    var messages = response.messages

    if (!messages) {
      return reply.view('authenticated/noReceipt')
    }

    user.messagesRemaining = messages.length

    messages.forEach(function (message) {
      gmail.users.messages.get({
        userId: user.googleId,
        id: message.id
      }, readMessage(request, reply, user))
    })
  }
}

function readMessage (request, reply, user) {
  return function (err, response) {
    if (err) reply(err)
    var headers = response.payload
      ? response.payload.headers
      : null

    if (!headers) {
      return reply.view('authenticated/noReceipt')
    }

    headers.forEach(function (header) {
      if (header.name === 'From') {
        if (header.value.indexOf('uber.us@uber.com') > -1) {
          var snippet = response.snippet
          var price = snippet.split(' ')[0]
          if (isMoney(price)) user.prices.push(price.split('$')[1])
          user.messagesRemaining--
          if (!user.messagesRemaining) {
            var total = user.prices.reduce(function (sum, value) {
              return sum + parseFloat(+value)
            }, 0)
            return reply.view('authenticated/total', {
              spent: total.toFixed(2)
            })
          }
        }
      }
    })
  }
}
