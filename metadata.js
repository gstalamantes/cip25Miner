const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const SERVER_URL = "http://<yourKupoIP>";  //Add your Kupo IP address here
const PROGRESS_FILE = path.join(__dirname, 'progress.json');  //Progress is maintained via this file.  If issues arise, delete this to reset the process from the beginning.

const BATCH_SIZE = 50;        //SQL Batch size- entries will be pushed to SQL after 50 matches are prepared.
const MAX_METADATA_LENGTH = 75535;  //Metadata size.  If set too low, errors will occur.  Alter to your needs. 

const dbConfig = {
  host: '<databaseIPaddress>',    //Add you SQL IP here
  user: '<dbUsername>',           //Add you SQL username here
  password: '<dbPassword>',       //Add you SQL password here
  database: '<dbName>',           //Add you SQL db/schema name here
  charset: 'utf8mb4' 
};

async function fetch(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const request = lib.get(url, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return reject(new Error('statusCode=' + response.statusCode));
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch (error) {
          reject(new Error(`Failed to parse JSON response: ${error.message}`));
        }
      });
    });

    request.on('error', reject);
  });
}

async function fetchMetadata(slotNo, transactionId) {
  try {
    const response = await fetch(`${SERVER_URL}/metadata/${slotNo}?transaction_id=${transactionId}`);
    
    const schemas = [];
    for (const item of response) {
      if (item.schema && item.schema[721]) {
        schemas.push(item.schema[721]);
      }
    }

    if (schemas.length > 0) {
      return schemas;
    } else {
      throw new Error('Schema 721 not found');
    }
  } catch (e) {
    console.error(`Error fetching metadata for transaction ${transactionId}:`, e.message || e);
    return null;
  }
}

async function fetchMatches() {
  console.log("Fetching matches from the server...");
  try {
    const matches = await fetch(`${SERVER_URL}/matches?unspent`);   //Match URL - By default will pull all matches from index pattern set via Kupo, but can be filtered here.  Refer to Kupo docs for more info
    console.log("Successfully fetched matches from the server.");
    return matches;
  } catch (err) {
    console.error("Error fetching matches from the server:", err.message || err);
    throw err;
  }
}

function readJsonFile(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      console.error(`Failed to parse JSON file at ${filePath}: ${error.message}`);
      return { processedTransactionIds: [], pendingMetadataBatch: [] };
    }
  }
  return { processedTransactionIds: [], pendingMetadataBatch: [] };
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function readProgress() {
  const progress = readJsonFile(PROGRESS_FILE);
  const processedTransactionIds = new Set(progress.processedTransactionIds);
  const pendingMetadataBatch = progress.pendingMetadataBatch || [];
  return { processedTransactionIds, pendingMetadataBatch };
}

async function writeProgress(processedTransactionIds, pendingMetadataBatch) {
  const progress = {
    processedTransactionIds: Array.from(processedTransactionIds),
    pendingMetadataBatch
  };
  writeJsonFile(PROGRESS_FILE, progress);
}

async function insertMetadataBatch(connection, batch) {
  if (batch.length === 0) return;

  const query = `
    INSERT INTO cip25 (policyid, assetname, metadata, slotno)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      metadata = IF(VALUES(slotno) > slotno, VALUES(metadata), metadata),
      slotno = IF(VALUES(slotno) > slotno, VALUES(slotno), slotno)
  `;
  try {
    await connection.query(query, [batch]);
    console.log(`Inserted batch of ${batch.length} metadata entries into the database.`);
  } catch (error) {
    console.error('Error inserting metadata batch:', error);
  }
}

async function getExistingAssetsFromDB(connection) {
  const [rows] = await connection.query('SELECT policyid, assetname, slotno FROM cip25');
  const assetsMap = new Map(rows.map(row => [`${row.policyid}-${row.assetname}`, row.slotno]));
  console.log(`Fetched ${assetsMap.size} existing assets from the database.`);
  return assetsMap;
}

async function processMatches() {
  const { processedTransactionIds, pendingMetadataBatch } = await readProgress();
  const connection = await mysql.createConnection(dbConfig);
  const dbAssetsMap = await getExistingAssetsFromDB(connection);

  let matches = [];
  if (pendingMetadataBatch.length === 0) {
    matches = await fetchMatches();
  } else {
    console.log("Resuming from pending metadata batch...");
  }

  const metadataBatch = pendingMetadataBatch;

  for (const match of matches) {
    const { transaction_id, created_at } = match;
    const slotNo = created_at.slot_no;

    if (processedTransactionIds.has(transaction_id)) {
      console.log(`Transaction ${transaction_id} already processed. Skipping...`);
      continue;
    }

    console.log(`Processing transaction ${transaction_id} at slot ${slotNo}...`);
    try {
      const metadataArray = await fetchMetadata(slotNo, transaction_id);
      if (metadataArray) {
        for (const metadata of metadataArray) {
          for (const entry of metadata.map) {
            if (entry.k && entry.k.string && entry.v && entry.v.map) {
              const policyId = entry.k.string;
              const assets = entry.v.map;

              for (const asset of assets) {
                if (asset.k && asset.k.string && asset.v) {
                  const assetName = asset.k.string;
                  const metadataObj = asset.v.map;
                  const metadataStr = metadataObj ? JSON.stringify(metadataObj) : null;
                  
                  if (metadataStr === null) {
                    console.warn(`Skipping asset ${assetName} with policy ID ${policyId} due to undefined metadata.`);
                    continue;
                  }
                  
                  const assetKey = `${policyId}-${assetName}`;
                  const existingSlotNo = dbAssetsMap.get(assetKey);

                  if (metadataStr.length <= MAX_METADATA_LENGTH && (!existingSlotNo || slotNo > existingSlotNo)) {
                    metadataBatch.push([policyId, assetName, metadataStr, slotNo]);
                    dbAssetsMap.set(assetKey, slotNo);
                    console.log(`Prepared metadata for asset: ${assetName} with policy ID: ${policyId}`);
                  } else if (metadataStr.length > MAX_METADATA_LENGTH) {
                    console.log(`Metadata for asset ${assetName} exceeds maximum length and will not be inserted.`);
                  } else {
                    console.log(`Asset ${assetName} with policy ID ${policyId} already exists in the database with a more recent slot number.`);
                  }
                }
              }
            }
          }
        }
      }
      processedTransactionIds.add(transaction_id);
      await writeProgress(processedTransactionIds, metadataBatch); 

      if (metadataBatch.length >= BATCH_SIZE) {
        await insertMetadataBatch(connection, metadataBatch.splice(0, BATCH_SIZE));
        await writeProgress(processedTransactionIds, metadataBatch); 
      }
    } catch (error) {
      console.error(`Error processing transaction ${transaction_id}:`, error);
    }
  }

  if (metadataBatch.length > 0) {
    await insertMetadataBatch(connection, metadataBatch);
    await writeProgress(processedTransactionIds, []); 
  } else {
    console.log("No new metadata entries to insert into the database.");
  }

  await connection.end();
  console.log("Metadata fetch process completed.");
}

async function main() {
  let firstRun = true;
  while (true) {
    if (!firstRun) {
      console.log("Waiting 15 minutes before re-fetching matches...");
      await new Promise(resolve => setTimeout(resolve, 900000));  //Process will restart to grab new matches 15 minutes after completing.  Change based on your needs.
    } else {
      firstRun = false;
    }

    try {
      await processMatches();
    } catch (error) {
      console.error("Unhandled error:", error);
    }
  }
}

main().catch(err => console.error("Unhandled error:", err));
