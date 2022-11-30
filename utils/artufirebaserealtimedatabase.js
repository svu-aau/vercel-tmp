import '../utils/config';
import { initializeApp } from "firebase/app";
import { getDatabase, ref, child, get, set, update, remove, push } from "firebase/database";
import {
  getLogDate,
  INFO,
  WARNING,
  ERROR,
} from '../utils/common';

export default class ArtuFirebaseRealTimeDatabase {
  static db;

  constructor(requestId = null) {
    const app = initializeApp(this.#getConfig()); 
    this.db = getDatabase();
    this.requestId = requestId ?? 'Optional request ID not provided';
  }

  #getConfig() {
    // Config source: the Project's App settings:
    // https://console.firebase.google.com/project/marketing-api-dcf84/settings/general/web:NDU5NTI3MjItNDJiOC00YTk0LTkwZTMtMWU3Nzg1MjY2NDZl
    return {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      // from: https://console.firebase.google.com/project/marketing-api-dcf84/database/marketing-api-dcf84-default-rtdb/data
      databaseURL: process.env.FIREBASE_DATABASE_URL
    };
  }

  async createData(rootElementName, childKey, dataObj) {
    try {
      // to save an array as value, call this method with a null childKey and dataObj as {myArray: [ ... ]}
      const path = childKey ? `${rootElementName}/${childKey}` : rootElementName;
      await set(ref(this.db, path), dataObj)
      console.log(this.createLogMessage(INFO, 'createData', `Data created successfully using:  ${JSON.stringify({rootElementName, childKey, dataObj})}`));
    }
    catch(err) {
      console.log(this.createLogMessage(ERROR, 'createData', `Exception caught using: ${JSON.stringify({rootElementName, childKey, dataObj})}`, err));
    };
  }

  // Firebase doesn't recommend using arrays as values as explained here: https://firebase.blog/posts/2014/04/best-practices-arrays-in-firebase
  // Recommended approach is to push new objects to the path using an auto-generated key: https://firebase.google.com/docs/database/web/lists-of-data
  // (if really want to use array as value, look at createData() method above)
  async createDataWithAutoKey(rootElementName, dataObj) {
    try {
      // Create a reference with an auto-generated key
      const listRef = ref(this.db, rootElementName);
      const newRef = push(listRef); // auto generated key
      await set(newRef, dataObj)
      console.log(this.createLogMessage(INFO, 'createDataWithAutoKey',  `Data with auto key created successfully using: ${JSON.stringify({rootElementName, newRef, dataObj})}`));
    }
    catch(err) {
      console.log(this.createLogMessage(ERROR, 'createDataWithAutoKey', `Exception caught using:  ${JSON.stringify({rootElementName, newRef, dataObj})}`, err));
    };
  }
  
  async readData(rootElementName, childKey) {
    let data = null;
    try {
      const dbref = ref(this.db);
      const path = childKey ? `${rootElementName}/${childKey}` : rootElementName;
      const snapshot = await get(child(dbref, path));
      if (snapshot.exists()) {
        data = snapshot.val();
        console.log(this.createLogMessage(INFO, 'readData', `Data for path '${path}' using: ${JSON.stringify({rootElementName, childKey})} : ${JSON.stringify(data)}`));
      }
      else {
        console.log(this.createLogMessage(WARNING, 'readData', `No data found for path ${path} using: ${JSON.stringify({rootElementName, childKey})}`));
      }
    }
    catch(err) {
      console.log(this.createLogMessage(ERROR, 'readData', `Exception caught using: ${JSON.stringify({rootElementName, childKey})}`, err));
    }
    finally {
      return data;
    }
  }
    
  async updateData(rootElementName, childKey, dataObj) {
    try {
      await update(ref(this.db, `${rootElementName}/${childKey}`), dataObj)
      console.log(this.createLogMessage(INFO, 'updateData', `Data updated successfully using: ${JSON.stringify({rootElementName, childKey, dataObj})}`));
    }
    catch(err) {
      console.log(this.createLogMessage(ERROR, 'updateData', `Exception caught using: ${JSON.stringify({rootElementName, childKey, dataObj})}`, err));
    };
  }
  
  async deleteData(rootElementName, childKey) {
    try {
      const path = childKey ? `${rootElementName}/${childKey}` : rootElementName;
      await remove(ref(this.db, path));
      console.log(this.createLogMessage(INFO, 'deleteData', `Data deleted successfully using: ${JSON.stringify({rootElementName, childKey})}`));

    }
    catch(err) {
      console.logconsole.log(this.createLogMessage(ERROR, 'deleteData', `Exception caught using: ${JSON.stringify({rootElementName, childKey})}`));
    };
  }

  createLogMessage(level, source, msg, err = null) {
    return([
      this.requestId,
      getLogDate(),
      level,
      `ArtuFirebaseRealTimeDatabase.${source}()`,
      msg,
      err ? err : null
    ].join(' | '));
  }
}