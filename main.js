const http = require('http');
const fs = require('fs');
const path = require('path');

const cql = require('cql-execution');
const cqlfhir = require('cql-exec-fhir');
const cqlvsac = require('cql-exec-vsac');

// JLD: Hardcode these for now
const version = 'r4';
const umlsApiKey = '39f22d5a-d804-4e9e-a90a-58b198822116';




// Set up the library
const fhirHelpersLib = {
	FHIRHelpers: JSON.parse(fs.readFileSync(path.join(__dirname, 'fhir-helpers', version, 'FHIRHelpers.json'), 'utf8'))
};
const fhirHelpersRep = new cql.Repository(fhirHelpersLib);

// Create the patient source
let patientSource;
switch (version) {
case 'dstu2': patientSource = cqlfhir.PatientSource.FHIRv102(); break;
case 'stu3': patientSource = cqlfhir.PatientSource.FHIRv300(); break;
case 'r4': patientSource = cqlfhir.PatientSource.FHIRv401(); break;
default: patientSource = cqlfhir.PatientSource.FHIRv401(); break;
}

// Set up the code service, loading from the cache if it exists
const codeService = new cqlvsac.CodeService(path.join(__dirname, 'vsac_cache'), true);

const hostname = '127.0.0.1';
const port = 3000;

const server = http.createServer(async (req, res) => {
	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json');

	console.log('Request received:')
	console.log('	Method: ' + req.method);
	console.log('	URL: ' + req.url);
	console.log('	Headers: ' + JSON.stringify(req.headers));
	console.log();
	let data = '';
	for await (const chunk of req) {
		data += chunk;
	}
	console.log(`Data received: \r\n${data}\r\n`);
	
	const urlAry = req.url.split('/');
	if (urlAry[1] == 'measure') {
		const measure = urlAry[2];
		// Set up the library
		const elmFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'cql', version, measure+'.json'), 'utf8'));
		const measureLib = new cql.Library(elmFile, fhirHelpersRep);
		// Extract the value sets from the ELM
		let valueSets = [];
		if (elmFile.library && elmFile.library.valueSets && elmFile.library.valueSets.def) {
			valueSets = elmFile.library.valueSets.def;
		}
		// Load the bundle from the request body into the patientSource
		const bundles = [];
		const json = JSON.parse(data);
		bundles.push(json);
		patientSource.reset();
		patientSource.loadBundles(bundles);
		
		// Ensure value sets, downloading any missing value sets
		codeService.ensureValueSetsWithAPIKey(valueSets, umlsApiKey).then(() => {
			// Value sets are loaded, so execute!
			const executor = new cql.Executor(measureLib, codeService);
			const results = executor.exec(patientSource);
			console.log(results);
			res.end(JSON.stringify(results.patientResults));
		})
		.catch( (err) => {
			// There was an error!
			console.error('Error', err);
		});
	}
	else {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'text/plain');
		let returnBody = 'URL not found: ' + req.url
		console.log(returnBody);
		res.end(returnBody);
		return;
	}
  

  
  
  
  

  
  
  
  
  
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});