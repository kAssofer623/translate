const mysql = require('mysql2/promise');
const { Client } = require('@elastic/elasticsearch');
const fs = require('fs');

const esClient = new Client({
  node: 'https://localhost:9200',
  auth: {
    username: 'elastic',
    password: '4GzBGuWbSnsfps8eopp4',
  },
  tls: {
    ca: fs.readFileSync('./http_ca.crt'),
    rejectUnauthorized: false,
  },
});

async function deleteLogsInAppLogsDataView() {
  const response = await esClient.deleteByQuery({
    index: 'app-*',
    body: {
      query: {
        match_all: {}
      }
    }
  });
}
async function main() {
  console.log('Starting cleanup...');
  await deleteLogsInAppLogsDataView();
  console.log('Kibana Cleanup completed successfully');
}

main();

async function cleanup() {
  try {
    // Connect to the MySQL database
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'kass',
      password: '021580881',
      database: 'users',
    });

    // Delete all users except the default admin user (ID 1)
    const [result] = await connection.execute('DELETE FROM users WHERE id != 253');

    // Close the database connection
    await connection.end();

    console.log('SQL DATABASE Cleanup completed successfully');
  } catch (error) {
    console.error('Error during cleanup: ' + error.message);
  }
}

cleanup();
