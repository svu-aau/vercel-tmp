import Mailgun from 'mailgun.js';
import FormData from 'form-data';
import jwt from 'jsonwebtoken'; // installing requires `yarn add jsonwebtoken` and `yarn add @types/jsonwebtoken` or will get module not found error
import axios from 'axios';

export const INFO = 'INFO';
export const WARNING = 'WARNING';
export const ERROR = 'ERROR';
export const NA = 'N/A';
export const AUTHORIZATION = 'Authorization';
export const MASKED_FOR_SECURITY = '*** masked for security ***';

const TIMEZONE = 'America/Los_Angeles';

export function getLogDate() { 
  try {
    return (new Date()).toLocaleString('en-us', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      timeZoneName: 'short',
      timeZone: TIMEZONE
    })
  }
  catch (err) {
    handleGenericError(`Exception caught in utils/common.js::getLogDate()`, err);
  } 
}

export function getLogMessage(req, res, requestId, requestMethod, status, message) {
  try {
    // the Request object is a Node Request object (not Express Request object)

    let requestUrl = sanitizeRequestUrl(req.url);
    return [
      requestId,
      getLogDate(),
      req.headers['user-agent'] ?? 'N/A',
      requestMethod ? requestMethod : req.method,
      (req.headers.host ?? '') + requestUrl,
      status,
      message
    ].join(' | ');
  }
  catch (err) {
    handleGenericError(`Exception caught in utils/common.js::getLogMessage()`, err);
  }
}

/**
 * Sanitize the request URL
 * 
 * Example: if the API request receives a GET request, the URL may contain an Authorization query param; if so mask it for security
 */
export function sanitizeRequestUrl(url) {
  const reAuthorizationMatch = new RegExp(`${AUTHORIZATION}=`, 'i');
   // have to double escape the question mark below if using template literal
  const reAuthorizationReplace = new RegExp(`(\\?|&)(${AUTHORIZATION}=)(.*?)(&|$)`, 'i');
  return (url && url.match(reAuthorizationMatch)) ? url.replace(reAuthorizationReplace, `$1$2${MASKED_FOR_SECURITY}$4`) : url;
}

/**
 * Sanitize the URL query params
 * 
 * Example: if the API request receives a GET request, the query object may contain an Authorization property; if so mask it for security
 * 
 */
export function sanitizeUrlQueryParams(queryParamsObj) {
  // must use spread operator to copy the object; 
  // otherwise using var = object will make var a reference to same object and update the funcation callee's object (would make this an impure function)
  // https://stackoverflow.com/questions/12690107/clone-object-without-reference-javascript
  let sanitizedQueryParamsObj = { ...queryParamsObj };
  if (sanitizedQueryParamsObj[AUTHORIZATION]) { 
    sanitizedQueryParamsObj[AUTHORIZATION] = MASKED_FOR_SECURITY; 
  }
  return sanitizedQueryParamsObj;
}

export function getRequestId() {
  try {
    // getLogDate() output example: 11/04/2022, 02:08:12.884 AM PDT
    return getLogDate().replace(/^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})\.(\d{3}).*$/, '$3$1$2$4$5$6$7');    
  }
  catch (err) {
    handleGenericError(`Exception caught in utils/common.js::getRequestId()`, err);
  }
}

export function handleApiError(error, requestId, req, res) {
  /*
   * determine if API response error or other types of error (eg, code, runtime, etc.)
   */
  let errorContent = null;
  let errorObj = error;
  let errorCode = ERROR;
  const requestUrl = sanitizeRequestUrl(req.url);
  try {
    // NOTE: API (vs. code) error object has a 'response' object so need to access it to get friendly error message
    // reference: https://axios-http.com/docs/handling_errors
    if (error.response) {
      if (error.response.data) { 
        errorObj = error.response.data; 
        if (errorObj.message && (
            errorObj.message.match(/Tour\/Open House Date.*?is in the past to attend/i) ||
            errorObj.message.match(/An active NTX Service Indicator already exists/i)
          )
        ) { 
            errorCode = WARNING; 
          }
      }
      else { errorObj = error.response; }
    }
    // try to set the error to a string so it's easier to read in the log
    try { 
      errorContent = JSON.stringify(errorObj);
      // if the error is a coding error, then JSON.stringify will not error out, but will return a useless empty object string, '{}'
      if (errorContent === '{}') {
        errorContent = errorObj;
      }
    }
    // catch possible circular reference error converting obj to string
    catch (e) { errorContent = errorObj; }
    /*
     * Send email using Mailgun JS API: https://github.com/mailgun/mailgun.js
     */
    const mailgun = new Mailgun(FormData);
    const mg = mailgun.client({
      username: process.env.MAILGUN_USERNAME,
      key: process.env.MAILGUN_API_KEY,
    });
    mg.messages.create(process.env.MAILGUN_DOMAIN, {
      from: 'stevedvu@gmail.com',
      to: 'svu@academyart.edu',
      subject: `[${errorCode}] ${requestUrl}`,
      // if setting email content to an object, may get `source.on` error, so just reference the log to see details
      text: typeof errorContent === 'object' ? `Could not embed error object in Mailgun content; see error log ID ${requestId}` : 
        `${errorContent}\n\nRequest ID: ${requestId}`,
    })
      .then((msg) => console.log(getLogMessage(req, res, requestId, NA, INFO, `Email successfully sent: ${JSON.stringify(msg)}`)))
      .catch((mailError) => console.log(getLogMessage(req, res, requestId, NA, ERROR, `Exception caught sending email: ${JSON.stringify(mailError)}`)))
      .finally (() => {
        if (typeof errorContent === 'object') {
          // output the error object outside the string so get actual error details instead of `[object Object]`
          console.log(getLogMessage(req, res, requestId, NA, errorCode, `Exception caught in ${requestUrl}:\n`), errorContent);
        } else {
          console.log(getLogMessage(req, res, requestId, NA, errorCode, `Exception caught in ${requestUrl}: ${errorContent}`));
        }
        let errorStatusCode = error.response ? error.response.status : 500;
        // if call is from slicktextwebhook, ALWAYS send a status 200 back to Slicktext to tell it you've received its POST data
        // reference: https://api.slicktext.com/webhooks/setup.php#3
        if (req.url.match(/slicktextwebhook/i)) { errorStatusCode = 200; }
        res.status(errorStatusCode).json(errorObj);
      });    
  }
  catch (err) {
    console.log(getLogMessage(req, res, requestId, NA, errorCode, `Exception caught in ./utils/common.js::handleApiError:\n`), err);
  }
}

export function handleGenericError(msg, err) {
  try {
    console.log([
      getLogDate(),
      ERROR,
      msg,
      err
    ].join(' | '));
  }
  catch (err) {
    console.log([
      getLogDate(),
      ERROR,
      `Exception caught in utils/common.js::handleGenericError()`,
      err
    ].join(' | '));
  }
}

export async function sendEmail(req, res, requestId, from, to, subject, text) {
  try {
    const mailgun = new Mailgun(FormData);
    const mg = mailgun.client({
      username: process.env.MAILGUN_USERNAME,
      key: process.env.MAILGUN_API_KEY,
    });
    const msg = await mg.messages.create(process.env.MAILGUN_DOMAIN, {
      from: from,
      to: to,
      subject: subject,
      text: text,
    });
    console.log(getLogMessage(req, res, requestId, NA, INFO, `Email successfully sent: ${JSON.stringify(msg)}`));
  }
  catch (err) {
    handleGenericError(`Exception caught in utils/common.js::sendMail()`, err);
  }
}

/**
 * Get access_token from auth0
 * 
 * reference: https://manage.auth0.com/dashboard/us/dev-2d73xy3s/apis/5e7d7445ff5c2808c2842033/test
 * 
 */
export async function getAuth0AccessToken() {
  try {
    const auth0AuthenticationResponse = await axios({
      url: process.env.AUTH0_OAUTH_URL,
      method: 'POST',
      headers: {'content-type': 'application/json'},
      data: {
        'client_id': process.env.AUTH0_CLIENT_ID,
        'client_secret': process.env.AUTH0_CLIENT_SECRET,
        'audience': process.env.AUTH0_AUDIENCE,
        'grant_type': process.env.AUTH0_GRANT_TYPE
      }
    });
    // console.log(`*** SVU: auth0AuthenticationResponse.data:`, auth0AuthenticationResponse.data);
    return auth0AuthenticationResponse.data.access_token;
  }
  catch (err) {
    handleGenericError(`Exception caught in utils/common.js::getAuth0AccessToken()`, err);
  }
}

/**
 * Decode jwt token 
 * (decodes the jwt only! Does not verfiy the jwt signature)
 *
 * reference: https://github.com/auth0/node-jsonwebtoken#jwtdecodetoken--options
 */
export function decodeJWT(token) {
  try {
    // {complete: true} option returns decoded header and payload, along with untouched signature
    // {complete: false} option (or not including the option) just returns the decoded payload
    const decoded = jwt.decode(token, {complete: true});
    return decoded;
  }
  catch (err) {
    handleGenericError(`Exception caught in utils/common.js::decodeJWT()`, err);
  }
}

/**
 * Verify jwt signature
 * 
 * When the API client sends the JWT (aka, access_token), verify that its signature matches the original signature
 * given to the client by the authentication server; if not a match, then terminate request and respond with error. 
 * 
 * Quoting stackoverflow (https://stackoverflow.com/a/62095056):
 *  "So, how does this verification actually work? Well, it is actually quite straightforward. 
 *  Once the JWT is received (by the API server), the verification (process) will take its (the JWT) header and payload,  
 *  and together with the secret, that is still saved on the server (and the same one used by the Authorization server), 
 *  basically create a test signature.  
 * 
 *  But the original signature that was generated when the JWT was first created is still in the token, right? 
 *  And that's the key to this verification. Because now all we have to do is to compare the test signature with the 
 *  original signature. And if the test signature is the same as the original signature, then it means that the 
 *  payload and the header have not been modified." 
 * 
 * The signature is the third 'part' of the JWT:
 * 
 * I. JWT creation:
 * 
 *    JWT is a string composed of three parts, each separated by a period:   header.payload.signature
 *    1. header = base64 encoded header.  header is JSON containing algorithm used to encode signature.
 *    2. payload = base 64 encoded payload. payload contains user or application JSON and should not contain secure data as it can be easily base64url decoded
 *    3. signature = encoding algorithm(#1.#2, secret)
 *        - secret is any string you want to use, but should be kept away from prying eyes
 *        - locate secret used by auth0 for your app: 
 *          - https://auth0.com/docs/secure/tokens/json-web-tokens/validate-json-web-tokens#verify-rs256-signed-tokens
 *          - the app Settings we are using: https://manage.auth0.com/dashboard/us/dev-2d73xy3s/applications/cLDmalrmqLr7S8mukBLsbMsLq8fELENU/settings
 *          - looks like: -----BEGIN CERTIFICATE-----
 *                        MIIDBzCCAe+gAwIBAgIJ...
 *                       -----END CERTIFICATE-----
 * 
 * II. JWT validation / verification
 * 
 *    Manual process of validating signature by working backwards of how the JWT was created
 *    #a. parse JWT for base64 encoded header
 *    #b. parse JWT for base64 encoded payload (aka, claims)
 *    #c. base64 decode the header to get the signature signing algorithm, eg, 'RS256'
 *    #d. make sure you know the 'secret' the authentication server used to generate the JWT secret
 *    #e. manually create the signature based on above.  For example, if signing algortihm = RS256:
 *        original JWT should be = RS256encode(#a#b#d)
 *    #f. compare #e to #3 ... they should match
 * 
 *    The jwt.verify() method below is doing what is described above.  If the verification is a success, the method
 *    will return "the payload decoded if the signature is valid and optional expiration, audience, or issuer are valid. If not, it will throw the error."
 *    reference: https://github.com/auth0/node-jsonwebtoken#jwtverifytoken-secretorpublickey-options-callback
 * 
 * III. Simple example to create JWT and validate JWT:
 *
 *    To create JWT, authentication server uses the following data:
 * 
 *      i. header: {"alg": "HS256", "typ": "JWT" }
 *        - using https://jwt.io, the base64url encoded header = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 
 *      ii. payload/claim: {"email": "me@academyart.edu"}
 *        - using https://jwt.io, the base64url encoded payload =  eyJlbWFpbCI6Im1lQGFjYWRlbXlhcnQuZWR1In0
 *      iii. secret = my-secret-key-for-your-eyes-only
 *        - can be any value
 *      iv. signature = base64UrlEncode( HMACSHA256( base64UrlEncode(header) + "." + base64UrlEncode(payload), secret )
 *        - note that must use the same algorithm specified in i., ie, HS256 = HMAC SHA256 = SHA-256
 *        - https://jwt.io calcuates the signature as:  Rf8KTIA0AKvm14ES4jwGo6V5fcIoHra5hqmg1cybXrM
 * 
 *      The resulting JWT is: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6Im1lQGFjYWRlbXlhcnQuZWR1In0.Rf8KTIA0AKvm14ES4jwGo6V5fcIoHra5hqmg1cybXrM
 * 
 *    To validate the JWT when the API client makes a request that includes the JWT (aka, access_token), the API server should:
 * 
 *      a. parse the JWT to get the base64url encoded header (ie, the first part of the JWT)
 *      b. parse the JWT to get the base64url encoded payload (ie, the secode part of the JWT)
 *      c. MUST have the same secret the Authentication server has, ie, my-secret-key-for-your-eyes-only
 *      d. combine a, b, c using the same formula as in iv. above to calculate the signature.
 *          - if this signature is the same as what is in the third part of the JWT, then the JWT is valid
 *          - the signature can only match IFF both the authentication server and JWT validator share the secret!!!  (The header and payload can be easily decoded by anyone using a base64url decoder) 
 *          - note 1: can use online HS256 generator at: https://www.devglan.com/online-tools/hmac-sha256-online. Form field values:
 *            - "Enter Plain Text to Compute Hash": eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6Im1lQGFjYWRlbXlhcnQuZWR1In0 (header.payload)
 *            - "Enter the Secret Key": my-secret-key-for-your-eyes-only (must as iii. above)
 *            - "Select Cryptographic Hash Function": SHA-256 (must be same as i. above)
 *            - "Output Text Format": Base64
 *            - note: the calcuated signature appears to add a trailing equal sign (=) that is not present in the https://jwt.io tool; not sure why???
 *          - note 2: can also try to re-create the token from the decoded header, decoded payload, and secret using
 *                    jsonwebtoken module's sign() method and then from the JWT, parse out the signature (the third item in the dot delimited JWT) and compare to 
 *                    to the JWT provided by the API client.  See reference R6. below.
 * 
 * IV. Helpful references:
 * 
 *    R1. auth0's JWT education site, including JWT encoder/decoder, JWT explanation: https://jwt.io 
 *    R2. auth0 JWT validation documentation: https://auth0.com/docs/secure/tokens/json-web-tokens/validate-json-web-tokens
 *    R3. high level explanation of how to validate JWT: https://developer.okta.com/docs/guides/validate-access-tokens/dotnet/main/#decoding-and-validating-the-access-token
 *    R4. visual explanation of JWT and how to validate: https://codecurated.com/blog/introduction-to-jwt-jws-jwe-jwa-jwk/
 *    R5. stackoverflow JWT validation explanation: https://stackoverflow.com/a/62095056
 *    R6. how to create (sign) JWT using jsonwebtoken module's sign() method: https://siddharthac6.medium.com/json-web-token-jwt-the-right-way-of-implementing-with-node-js-65b8915d550e
 */
export function verifyJTW(token, secret, signatureAlgorithm) {
  try {
    //If the verification is a success, the method will return "the payload decoded if the signature is valid and 
    // optional expiration, audience, or issuer are valid. If not, it will throw the error."
    const decoded = jwt.verify(token, secret, {algorithms: [signatureAlgorithm]});
    //console.log(`*** SVU: SUCCESS verifying jwt, secret from env!!!, decoded:\n`, decoded);
    return { isJWTverified: true, 'decoded': decoded };
  }
  // jwt.verify will throw error is jwt is not verified
  catch (err) {
    handleGenericError(`Exception caught in utils/common.js::verifyJTW()`, err);
    return { isJWTverified: false};
  }
}

/**
 * Custom authorization error: \
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error#custom_error_types
 */
export class MarketingApiAuthorizationError extends Error {
 constructor(message, ...params) {
   // Pass remaining arguments (including vendor specific ones) to parent constructor
   super(...params);

   // Maintains proper stack trace for where our error was thrown (only available on V8)
   if (Error.captureStackTrace) {
     Error.captureStackTrace(this, MarketingApiAuthorizationError);
   }

   this.name = 'MarketingApiAuthorizationError';
   // Custom debugging information
   this.messsage = message;
 }
}
