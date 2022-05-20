const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const cql = require('cql-execution');
const cqlfhir = require('cql-exec-fhir');
const cqlvsac = require('cql-exec-vsac');

// TO DO: This should come from a request parameter
const debug = false;
var debugRequest;

// TO DO: There is supposed to be a way to set this within the environment so it
//        doesn't have to be passed as an argument to the script. Investigate and
//        document how to do this.
const umlsApiKey = process.argv[2]
if ((umlsApiKey==undefined)||(umlsApiKey==null)) {
	let errorMsg = 'ERROR: No UMLS API key given; Script MUST be invoked with UMLS API key \r\n';
	errorMsg += 'Ex:\r\n'
	errorMsg += '\t\\isc-garza-cql-server>node main.js 98ffbd39-f414-48af-9f69-ae5de30d6c33'
	console.error(errorMsg);
	return;
}

// TO DO: Hardcode this for now. In the future, it should probably be obtained from
//      the request URL.
const version = 'r4';

// Root path is the project repo directory, e.g., C:\Users\<user>\Documents\GitHub\isc-garza-cql-server
const rootPath = '.\\';
const elmPath = rootPath + 'elm\\';
const fhirTermPath = rootPath + 'fhirterminology\\';
const vsacCachePath = rootPath + 'vsac_cache\\';
const vsacCachePathAndFilename = vsacCachePath + 'valueset-db.json';

// Create the patient source and fhir wrapper objects, which depend on the FHIR version
let patientSource;
let fhirWrapper;
switch (version) {
case 'dstu2': patientSource = cqlfhir.PatientSource.FHIRv102(); fhirWrapper = cqlfhir.FHIRWrapper.FHIRv102(); break;
case 'stu3': patientSource = cqlfhir.PatientSource.FHIRv300(); fhirWrapper = cqlfhir.FHIRWrapper.FHIRv300(); break;
case 'r4': patientSource = cqlfhir.PatientSource.FHIRv401(); fhirWrapper = cqlfhir.FHIRWrapper.FHIRv401(); break;
default: patientSource = cqlfhir.PatientSource.FHIRv401(); fhirWrapper = cqlfhir.FHIRWrapper.FHIRv401(); break;
}

// If there are ValueSets (possibly inside Bundles) in the FHIR terminology folder,
// add those to the VSAC cache file before instantiating the VSAC code service.
addFhirToVsacCache();
// Set up the code service, loading from the cache if it exists
const codeService = new cqlvsac.CodeService(vsacCachePath, true);

// Instantiate message listener that will print messages logged from the CQL
const logSourceOnTrace = true;
const msgListener = new cql.ConsoleMessageListener(logSourceOnTrace);

const server = http.createServer(async (req, res) => {
	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json');
	let data = '';
	for await (const chunk of req) {
		data += chunk;
	}

	const parsedUrl = url.parse(req.url, true);
	const queryObj = parsedUrl.query
	debugRequest = (queryObj.debug == 'true');
	const urlPath = parsedUrl.pathname
	
	if (debugRequest) {
		console.log('\r\nRequest received:')
		console.log('\tMethod: ' + req.method);
		console.log('\tURL: ' + req.url);
		console.log('\tHeaders: ' + JSON.stringify(req.headers));
		console.log(`\tBody: ${data}\r\n`);
	}

	const urlAry = urlPath.split('/');
	if (urlAry[1] == 'measure') {
		const measure = urlAry[2];
		// Parse the ELM file for the measure into an object.
		// TO DO: This assumes the file is in elmPath, and its name matches the
		//   measure from the URL - not great. Consider re-thinking how this works.
		const elmFile = JSON.parse(fs.readFileSync(elmPath + measure + '.json', 'utf8'));	
		// Pass the ELM file object to getIncludedLibrariesObj() to get back an 
		// object referencing the libraries included by the measure
		let librariesObj = {};
		getIncludedLibrariesObj(elmFile, librariesObj);
		// Use librariesObj to make a repository object.
		let includesRep = new cql.Repository(librariesObj)
		// Use the ELM file for the measure and the repository of the included
		// libraries to make a library for the measure.
		const measureLib = new cql.Library(elmFile, includesRep);
		// Load the bundle from the request body into the patientSource
		const bundles = [];
		const json = JSON.parse(data);
		// prefetchBundle contains all the prefetched resource in a single Bundle.
		// Get this from the request and load into the patientSource.
		// TO DO: Validate that the request payload is a valid Bundle resource.
		bundles.push(json.prefetchBundle);
		patientSource.reset();
		patientSource.loadBundles(bundles);
		// Get the (CDS Hooks) context from the request
		// TO DO: To save time right now, only getting ContextPrescriptions from draftOrders
		const draftOrders = json.context.draftOrders;
		const entryArr = draftOrders.entry;
		let contextMedsArr = [];
		if (Array.isArray(entryArr)) {
			entryArr.forEach(oneEntry => contextMedsArr.push(fhirWrapper.wrap(oneEntry.resource)));
		}
		const parameters = {
		  ContextPrescriptions: contextMedsArr
		};
		
		
		// Ensure value sets, downloading any missing value sets
		codeService.ensureValueSetsInLibraryWithAPIKey(measureLib, true, umlsApiKey, true).then(() => {
			// Value sets are loaded, so execute!
			const executor = new cql.Executor(measureLib, codeService, parameters, msgListener);
			const results = executor.exec(patientSource);
			if (debugRequest) {
				res.end(JSON.stringify(results));
			}
			else
			{
				var returnResults = {patientResults: results.patientResults}
				res.end(JSON.stringify(returnResults));
			}
		})
		.catch( (err) => {
			// There was an error!
			console.log('In catch block following ensureValueSetsWithAPIKey()');
			console.error('Error', err);
			res.statusCode = 500;
			res.setHeader('Content-Type', 'text/plain');
			let returnBody = err.toString();
			res.end(returnBody);
			return;
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

/// Given the ELM file (as a JSON object) of a measure, build an object where each
/// property name is the local identifier of library included by the measure, and
/// each property value is the corresponding file (as a JSON object). This method
/// is called recursively on the included libraries so that the libraries included
/// by those libraries are also added to the output object, as are the libraries
/// included by those libraries, and so on.
function getIncludedLibrariesObj(elmFile, librariesObj) {
	// TO DO: This function does nothing with versions. Should it? Right now it
	//   just assumes all the versions will line up.
	if ((elmFile.library.includes == undefined) || (elmFile.library.includes.def == undefined)) {
		return;
	}

	for (includeDefObj of elmFile.library.includes.def) {
		// If there is not already a key for includeDefObj in librariesObj...
		//  parse the ELM file (where path=elmPath and name=includeDefObj.path)
		//  for the included library and set a property of librariesObj with
		//  name=includeDefObj.path, value=[parsed ELM file for that library]
		// NOTE: A previous version of this code used includeFedObj.localidentifier
		//  instead of includeDefObj.path. This would break sometimes because
		//  different measures can be referred to with the same local identifier.
		//  For example, in OpioidCDSCommon.cql, we have:
		//    include OMTKLogicMK2020 version '0.1.1' called OMTKLogic
		//  In the parsed ELM, the localIdentifier value of this include is "OMTKLogic" - 
		//  However there is also a CQL called "OMTKLogic".
		if (librariesObj[includeDefObj.path] == undefined) {
			// Parse the ELM file for the current included library
			// Assume that file path=(global)elmPath and name=includeDefObj.path
			// TO DO: Not great to make this assumption. Consider re-thinking how
			//   libraries get loaded.
			let includedElmFile = JSON.parse(fs.readFileSync(elmPath +  includeDefObj.path + '.json'));
			// Add the parsed file to the output object with key=localIdentifier
			librariesObj[includeDefObj.path] = includedElmFile;
			// Call this method recursively on the included ELM file, passing it
			//  the same inputIncludeObj.
			getIncludedLibrariesObj(includedElmFile, librariesObj);
		}
	}
}

/// In case the measure being evaluated references valuesets that are not in VSAC,
/// this method provides a mechanism to load codes from FHIR ValueSet resources 
/// into the VSAC cache as though they had been downloaded from VSAC. 
///
/// This function will scan the "fhirterminology" folder in rootPath (TO DO - not
/// a great way to do this) for JSON files containing either ValueSet or Bundle 
/// resources. (In the case of a Bundle resource, the resources it contains will
/// be iterated over and only ValueSet resources will be processed.) For each
/// ValueSet, if it has an expansion.contains value, the codes from that are added
/// to the cache. Otherwise, if the ValueSet has a compose.include value, the
/// codes from that are added.
///
/// The VSAC cache identifies value sets by OID and version. When this function
/// adds the contents of a ValueSet resource to the cache, it uses the "url"
/// property of the resource as the OID, and the "version" property as the version,
/// or "Latest" if that is not defined.
///
/// Note that the contents of a ValueSet resource will only be added to the cache
/// if there is not already a value set with matching OID/URL and version. If
/// the contents of a ValueSet change after it has been loaded, the cache file
/// ([rootPath]\vsac_cache\valueset-db.json) will have to be deleted in order to
/// re-load the ValueSet resource. (TO DO: Not a great way to do this. Re-think.)
function addFhirToVsacCache() {
	// If the FHIR terminology folder does not yet exist, create it and return.
	if (!fs.existsSync(fhirTermPath)) {
		fs.mkdirSync(fhirTermPath);
		return;
	}
	
	var vsacCacheObj = {};
	// TO DO: Provide a way to skip loading the existing cache
	// TO DO: Error handling - a parse error should just be skipped
	if (fs.existsSync(vsacCachePathAndFilename)){
		vsacCacheObj = JSON.parse(fs.readFileSync(vsacCachePathAndFilename, 'utf8'));
	}
	
	for (const filename of fs.readdirSync(fhirTermPath)) {
		if (!filename.endsWith('.json')) {
			continue;
		}
		const pathAndFilename = path.join(fhirTermPath, filename);
		const fhirResource = JSON.parse(fs.readFileSync(pathAndFilename));
		// TO DO: Validate that the file is valid FHIR
		if (fhirResource.resourceType == 'Bundle') {
			for (const entry of fhirResource.entry) {
				if (entry.resource.resourceType != 'ValueSet') {
					continue;
				}
				addFhirValueSetToVsacCache(entry.resource, vsacCacheObj);
			}
		}
		else if (fhirResource.resourceType == 'ValueSet') {
			addFhirValueSetToVsacCache(fhirResource, vsacCacheObj);
		}
	}
	
	let data = JSON.stringify(vsacCacheObj, null, 2);
	fs.writeFileSync(vsacCachePathAndFilename, data, (err) => {console.error('Error', err); });
}

/// Helper function to addFhirToVsacCache()
function addFhirValueSetToVsacCache(fhirValueSetResource, vsacCacheObj) {
	let vsUrl = fhirValueSetResource.url;
	let vsVersion = fhirValueSetResource.version;
	if (vsVersion == undefined) {
		vsVersion = 'Latest';
	}
	// If the VSAC cache already has this version of this ValueSet, return.
	// TO DO: Provide a way to have the FHIR ValueSet override what is in the
	//   VSAC cache, or merge into it.
	if (vsacCacheObj[vsUrl] == undefined) {
		vsacCacheObj[vsUrl] = {};
	}
	if (vsacCacheObj[vsUrl][vsVersion] != undefined) {
		return;
	}
	
	
	let codesAry = [];
	let codeSystem;
	// If the ValueSet has an expansion, get the codes from that. Otherwise, if 
	//  it has includes, use those.
	if ((fhirValueSetResource.expansion != undefined) && (fhirValueSetResource.expansion.contains != undefined)) {
		for (concept of fhirValueSetResource.expansion.contains) {
			codesAry.push(new cql.Code(concept.code, concept.system, concept.version, concept.display));
		}
	}
	else if ((fhirValueSetResource.compose!=undefined) && (fhirValueSetResource.compose.include!=undefined)) {
		for (include of fhirValueSetResource.compose.include) {
			codeSystem = include.system;
			if (!Array.isArray(include.concept)) {
				continue;
			}
			for (concept of include.concept) {
				codesAry.push(new cql.Code(concept.code, codeSystem, vsVersion, concept.display));
			}
		}
	}
	vsacCacheObj[vsUrl][vsVersion] = {oid:vsUrl, version:vsVersion, codes:codesAry};
}



const hostname = '127.0.0.1';
const port = 3000;
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/ \r\nUsing UMLS API key: ${umlsApiKey}`);
});