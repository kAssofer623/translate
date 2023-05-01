const fs = require('fs');
const { spawn } = require('child_process');

const runNuclei = async (urls, nucleiTemplatesPath, authFilePath) => {
  const outputFile = 'nuclei.log';
  console.log('\x1b[31m%s\x1b[0m', `Nuclei scan started against: ${urls}`);

  let headers = {};

  // Check if authFilePath is specified and read authentication file to obtain headers
  if (authFilePath) {
    try {
      const authData = JSON.parse(fs.readFileSync(authFilePath));
      headers = authData.headers;
      console.log('Obtained headers from authentication file.');
    } catch (error) {
      console.error('Error reading authentication file:', error);
      return;
    }
  }

  const urlList = urls.join('\n');

  const nucleiCmd = `echo '${urlList}' | nuclei -t ${nucleiTemplatesPath} -fr -nc -je ${outputFile} ${
    Object.keys(headers).map((key) => `-H '${key}: ${headers[key]}'`).join(' ')
  }`;

  return new Promise((resolve, reject) => {
    const terminalCommand = 'gnome-terminal';
    const terminalArgs = ['--', 'bash', '-c', `${nucleiCmd}`];

    const terminalProcess = spawn(terminalCommand, terminalArgs);

    terminalProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`Nuclei process exited with code ${code}`);
        reject(new Error(`Nuclei process exited with code ${code}`));
      } else {
        const logContents = fs.readFileSync(outputFile, 'utf8');
        resolve(logContents);
      }
    });
  });
};

module.exports = {
  runNuclei,
};
