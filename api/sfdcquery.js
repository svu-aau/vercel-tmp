/**
 * Query SFDC:
 * 1. Authenticate to get access_token
 * 2. Query Salesforce
 */
import '../utils/config';
import axios from 'axios';
import url from 'url';
import { Parser } from '@json2csv/plainjs';
import ArtuFirebaseRealTimeDatabase from '../utils/artufirebaserealtimedatabase';
import {  
  getLogMessage,
  getRequestId,
  handleApiError,
  MarketingApiAuthorizationError,
  sanitizeUrlQueryParams,
  sanitizeRequestUrl,
  sendEmail,
  AUTHORIZATION,
  INFO,
  MASKED_FOR_SECURITY,
  WARNING,
  ERROR,
  NA,
} from "../utils/common";

/* 
 * Vercel serverless functions (API):
 * https://vercel.com/docs/concepts/functions/serverless-functions/supported-languages#node.js
 */ 


module.exports = async (req, res) => {

  //console.log(`\n\n--- new request ---\n\n`);

   /* handle CORS requests; if sent by browser, the browser sends thge 'OPTIONS' method request */
   const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
    'Content-Type': 'application/json'
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers).end();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  );

  const requestId = getRequestId();
  try {
    
    const rootElementName = 'GoogleSearchPaidAdsReportRunDates';
    const childKey = 'lastRunDateTimes';
    let allRunDateTimes = null;
    let nextPreviousRunDateTime = null;

    /* 
     * --- NOTE:  this API receives a GET request (so can easily run in cron job) so all parameters are in query string ---
     */
    // req.query is an object representing the key/values in the url query string (ie, URL query params)
    const requestPayload = req.query; 
    let requestPayloadForLog = sanitizeUrlQueryParams(requestPayload);
    console.log(getLogMessage(req, res, requestId, null, INFO, `Request payload: ${JSON.stringify(requestPayloadForLog)}`));

    // determine if using uat or prod SFDC
    const isUAT = requestPayload.sfdcEnvironment && (requestPayload.sfdcEnvironment === 'uat') ? true : false;
    //console.log(`\n\n*** SVU: requestPayload.sfdcEnvironment, isUAT: ${requestPayload.sfdcEnvironment} | ${isUAT}\n\n`);

    const marketingApiKey = isUAT ? process.env.MARKETING_API_KEY_UAT : process.env.MARKETING_API_KEY;

    if (requestPayload[AUTHORIZATION] === marketingApiKey) {
      /*----------------------
       * get SFDC access_token
       *----------------------*/
      // set payload for x-www-form-urlencoded content type: https://axios-http.com/docs/urlencoded
      const params = new url.URLSearchParams({
        username: isUAT ? process.env.SFDC_USERNAME_UAT : process.env.SFDC_USERNAME,
        password: isUAT ? process.env.SFDC_PASSWORD_UAT : process.env.SFDC_PASSWORD,
        grant_type: isUAT ? process.env.SFDC_GRANT_TYPE_UAT : process.env.SFDC_GRANT_TYPE,
        client_id: isUAT ? process.env.SFDC_CLIENT_ID_UAT : process.env.SFDC_CLIENT_ID,
        client_secret: isUAT ? process.env.SFDC_CLIENT_SECRET_UAT : process.env.SFDC_CLIENT_SECRET
      });

      const oAuthResponse = await axios({
        url: isUAT ? process.env.SFDC_OAUTH_URL_UAT : process.env.SFDC_OAUTH_URL,
        method: 'post',
        headers: {
          'content-type': 'application/x-www-form-urlencoded'
        },
        data: params.toString()
      }); 

      // proceed only with 2xx http status code
      if (String(oAuthResponse.status).match(/^2\d+/)) {

        const {access_token: accessToken, instance_url: apiBaseUrl, token_type: tokenType } = oAuthResponse.data;

        /*----------------------------------------------------
         * use appropriate query based on request type
         *----------------------------------------------------*/
        const requestType = requestPayload.requestType;
        
        let apiUrl = null;
        let apiPayload = null;
        let apiMethod = 'GET';
        let apiHeaders = {
          AUTHORIZATION: `${tokenType} ${accessToken}`
        };

        // get datetime filter for the query
        const artuFirebaseRtdb = new ArtuFirebaseRealTimeDatabase(requestId);
        allRunDateTimes = await getRunDateTimes(artuFirebaseRtdb, rootElementName, childKey);
        const previousRunDateTime = allRunDateTimes[(allRunDateTimes.length - 1)];
        nextPreviousRunDateTime = getNextPreviousRunDateTime();

        // --- Google Search (GS) Ads Conversions ---
        if (requestType === 'googleSearchAdsConversions') {
          apiUrl = `${apiBaseUrl}/services/data/v52.0/query/`;
          const query = `
          SELECT 
            Id, URL_GCLID__c, Opportunity__c, Email__c, Marketing_Code__c, URL_Details__c, Advertising_Source__c, CreatedDate, Opportunity__r.StageName, Opportunity__r.Application_Date__c
          FROM
            Lead_Post__c 
          WHERE 
            URL_GCLID__c != null 
            AND Opportunity__c != null
            AND Opportunity__r.Application_Date__c != null
            AND CreatedDate > ${previousRunDateTime}
            AND CreatedDate < ${nextPreviousRunDateTime}
            AND First_Name__c != 'AAUTest'
          ORDER BY 
            Opportunity__r.Application_Date__c DESC
          `
          apiPayload = {
            q: query
          }
        }

        console.log(getLogMessage(req, res, requestId, apiMethod, INFO, `Request to SFDC using ${apiUrl} with payload: ${JSON.stringify(apiPayload)}`));

        // --- make the API request ---
        const apiResponse = await axios({
          url: apiUrl,
          method: apiMethod,
          headers: apiHeaders,
          // GET method requests send payload in `params` property (vs. `data` property for POST requests): https://axios-http.com/docs/req_config
          params: apiPayload,
        });

        console.log(getLogMessage(req, res, requestId, null, INFO, `Response from SFDC endpoint ${apiUrl}: ${JSON.stringify(apiResponse.data)}`));

        // --- post process the dataset if needed ---
        if (requestType === 'googleSearchAdsConversions') {
            const queryResults = apiResponse.data;
            let emailMsg = null;
            if (queryResults.totalSize) {
              let uniqueOpportunities = [];
              // keep only unique records (based on Opportunity ID) since an applicant can have multiple LeadPost records
              // (eg, applicant can have multiple LeadPost records -- Marketing Code (Comm key 4) = MMI, OLAP -- but associated with just one Opportunity ID)
              //
              // also, a lead can also apply manually (ie, not use OLAP), in which case, they may have an MMI LeadPost with Google Click ID, but an OLAP w/o a Google CLick ID 
              // (ie, AOS manually creates OLAP LeadPost but doesn't populate gclid)
              let uniqueConversions = queryResults['records'].filter((queryResult) => {
                let opportunityId = queryResult['Opportunity__c'];
                if (uniqueOpportunities.includes(opportunityId)) {
                  //console.log(`*** SVU: Found duplicate Opp ID: ${opportunityId}`);
                  return false;
                }
                uniqueOpportunities.push(opportunityId);
                return true;
              })

              // throw out any records that came from Mantra's get started forms (eg, applicant intially entered Salesforce before TouchPoint took over but only recently applied)
              let finalData = uniqueConversions.filter((conversion) => {
                const url = conversion['URL_Details__c'];
                if (url.match(/https?:\/\/getstarted\./i)) {
                  //console.log(`*** SVU: Found Mantra lead: ${conversion['URL_GCLID__c']} | ${conversion['CreatedDate']} | ${conversion['Opportunity__r']['Application_Date__c']} | ${url}`);
                  return false;
                }
                return true;
              });
              console.log(getLogMessage(req, res, requestId, null, INFO, 
                `Number of query records [${queryResults['records'].length}], unique Opportunities [${uniqueConversions.length}], final data [${finalData.length}]`));

              // convert JSON to CSV:
              // 1. github: https://github.com/juanjoDiaz/json2csv
              // 2. docs: https://juanjodiaz.github.io/json2csv/#/
              // 3. customize data selection: https://juanjodiaz.github.io/json2csv/#/advanced-options/data-selection
              const opts = {fields: [
                {
                  value: 'URL_GCLID__c',
                  label: 'Google Click ID',
                  default: ''
                },
                {
                  value: 'Opportunity__r.StageName',
                  label: 'Stage Name',
                  default: ''
                },
                {
                  value: 'Opportunity__r.Application_Date__c',
                  label: 'Application Date',
                  default: ''

                }
              ]};
              const parser = new Parser(opts);
              const csv = parser.parse(uniqueConversions);
              emailMsg = csv;
            }
            else {
              emailMsg = `No conversions for this run`;
              console.log(getLogMessage(req, res, requestId, null, INFO, emailMsg));
            }
            await sendEmail(req, res, requestId, 'svu@academyart.edu', 'stevedvu@gmail.com', 
              `[Academy of Art University] Google Search Paid Ads conversion report: ${previousRunDateTime} - ${nextPreviousRunDateTime}`, 
              emailMsg);
        }
        await setNextPreviousRunDateTime(artuFirebaseRtdb, rootElementName, childKey, allRunDateTimes, nextPreviousRunDateTime);
        res.status(200).send({success: true})

        await res.status(apiResponse.status).send(apiResponse.data);
      }
      else {
        throw new MarketingApiAuthorizationError(`Authorization failed for sfdc oAuth endpoint ${process.env.SFDC_OAUTH_URL}`);
      }
    }
    else {
      throw new MarketingApiAuthorizationError(`Authorization failed for sfdcquery endpoint ${sanitizeRequestUrl(req.url)}`);
    }
  } catch (err) {
    handleApiError(err, requestId, req, res);
  }
};


async function getRunDateTimes(artuFirebaseRtdb, rootElementName, childKey) {
  const allRunDateTimes = await artuFirebaseRtdb.readData(rootElementName, null);
  if (!allRunDateTimes) {
    return ['2022-11-22T23:59:59.999Z'];
  }
  else {
    return allRunDateTimes[childKey];
  }
}

function getNextPreviousRunDateTime() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}T00:00:00.000Z`;
}

async function setNextPreviousRunDateTime(artuFirebaseRtdb, rootElementName, childKey, allRunDateTimes, nextPreviousRunDateTime) {
  const newRunDateTimes = [...allRunDateTimes];
  newRunDateTimes.push(nextPreviousRunDateTime);
  const dataObj = {
    [childKey]: newRunDateTimes
  }
  await artuFirebaseRtdb.createData(rootElementName, null, dataObj);
}
