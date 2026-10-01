import { getMongoDb } from './mongodb.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;
const PATH = '__collectionPath';
const DOC_ID = '__docId';

function millis(v){
  if(!v) return 0;
  if(v instanceof Date) return v.getTime();
  if(v?.$date) return new Date(v.$date).getTime();
  if(v?._seconds) return Number(v._seconds)*1000;
  const n=Date.parse(v);
  return Number.isFinite(n)?n:0;
}

async function cleanup(){
  try{
    const db=await getMongoDb();
    const docs=db.collection('firestore_docs');
    const accounts=await docs.find({
      [PATH]:{$regex:/\/tradingAccounts$/},
      status:'breached'
    }).toArray();
    const now=Date.now();

    for(const doc of accounts){
      const breachedAt=millis(doc.breachedAt);
      if(!breachedAt){
        // Migration safety: old breached records get a fresh 7-day retention timestamp.
        await docs.updateOne({_id:doc._id},{$set:{breachedAt:new Date()}});
        continue;
      }
      if(now-breachedAt<RETENTION_MS) continue;

      const accountId=String(doc.accountId||doc[DOC_ID]||'');
      const path=String(doc[PATH]||'');
      const match=path.match(/^users\/([^/]+)\/tradingAccounts$/);
      const uid=match?.[1]||'';
      if(!uid||!accountId) continue;

      // Remove all position/history documents belonging to the breached account.
      await docs.deleteMany({[PATH]:`users/${uid}/tradingAccounts/${accountId}/positions`});

      const credentialId=String(doc.terminalCredentialId||'').trim();
      if(credentialId){
        await docs.deleteOne({[PATH]:'terminalCredentials',[DOC_ID]:credentialId});
      }

      await docs.deleteOne({
        [PATH]:`users/${uid}/challengeAccounts`,
        [DOC_ID]:accountId
      });

      // Remove the selected-account mirror if it still points to the deleted account.
      const selected=await docs.findOne({
        [PATH]:`users/${uid}/trading`,
        [DOC_ID]:'account'
      });
      if(selected&&String(selected.accountId||'')===accountId){
        await docs.deleteOne({_id:selected._id});
      }

      await docs.deleteOne({_id:doc._id});
      console.log(`[breach-retention] deleted ${accountId} after 7 days`);
    }
  }catch(e){
    console.warn('[breach-retention] cleanup failed:',e?.message||e);
  }
}

setTimeout(cleanup,5000);
setInterval(cleanup,INTERVAL_MS);
