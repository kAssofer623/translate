const express = require('express');
const cors = require('cors');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const { crawl } = require('./crawler');
const { body, validationResult } = require('express-validator');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const swaggerDocument = YAML.load('./swagger.yaml');
const helmet = require('helmet');
const routes = require('./routes')
const { Client } = require('@elastic/elasticsearch');
const fs = require('fs')


const esClient = new Client({ 
  node: 'https://localhost:9200', 
  auth: {
    username: 'elastic',
    password: '4GzBGuWbSnsfps8eopp4'
  },
  tls: {
    ca: fs.readFileSync('./http_ca.crt'),
    rejectUnauthorized: false
  } 
});

app.use(express.json());
app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use(routes);

app.use((req, res, next) => {
  // res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:8000');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", 'maxcdn.bootstrapcdn.com']
    }
  },
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } },
  frameguard: { action: 'deny' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'same-origin' },
  xssFilter: true,
  noSniff: true,
  hidePoweredBy: false,
  dnsPrefetchControl: { allow: false }

}));


const port = 8000;
const io = new Server(server, {
});

app.use(cors());
app.use(express.json());


// // Socket connection
// io.on('connection', (socket) => {
//   sendLogToElasticsearch('info', 'WebSocket Communication Initiated');

//   socket.on('start-crawl', async (url) => {
//     try {
//       await crawl(url, (foundUrl) => {
//         socket.emit('found-url', foundUrl);
//       });
//     } catch (error) {
//       socket.emit('crawl-error', error.message);
//     }
//   });
// });

app.use((req, res, next) => {
  res.status(404).send('Resource not found');
});

app.use((err, req, res, next) => {
  sendLogToElasticsearch('error', err.stack);
  res.status(500).send('Internal server error');
});

server.listen(port, () => {
  sendLogToElasticsearch('info', `Server is running on port ${port}`);
});

async function sendLogToElasticsearch(level, message) {
  try {
    await esClient.index({
      index: `app-${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}`,
      body: {
        '@timestamp': new Date().toISOString(),
        level: level,
        message: message,
        service: 'app',
      },
    });
    console.log(`[${new Date().toISOString()}] Log sent to Elasticsearch: ${level.toUpperCase()} - ${message}`);
  } catch (error) {
    console.error('Error sending log to Elasticsearch:', error);
  }
}