import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

function getDb(){
  if(admin.apps.length) return admin.firestore();
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if(p){
    const serviceAccount = JSON.parse(readFileSync(p,'utf8'));
    admin.initializeApp({credential: admin.credential.cert(serviceAccount)});
  }else{
    admin.initializeApp();
  }
  return admin.firestore();
}

function millis(v){
  if(!v) return 0;
  if(typeof v.toDate==='function') return v.toDate().getTime();
  if(v._seconds) return Number(v._seconds)*1000;
  const n=Date.parse(v);
  return Number.isFinite(n)?n:0;
}

async function deletePositions(db, ref){
  const snap=await ref.collection('positions').get();
  if(!snap.size)return;
  let batch=db.batch(), count=0;
  for(const d of snap.docs){
    batch.delete(d.ref); count++;
    if(count>=450){await batch.commit();batch=db.batch();count=0;}
  }
  if(count)await batch.commit();
}

async function cleanup(){
  try{
    const db=getDb();
    const snap=await db.collectionGroup('tradingAccounts').where('status','==','breached').get();
    const now=Date.now();
    for(const doc of snap.docs){
      const data=doc.data()||{};
      let breachedAt=millis(data.breachedAt);
      if(!breachedAt){
        await doc.ref.update({breachedAt:admin.firestore.FieldValue.serverTimestamp()});
        continue;
      }
      if(now-breachedAt < RETENTION_MS) continue;

      const accountId=String(data.accountId||doc.id);
      const uid=String(doc.ref.parent.parent?.id||'');
      if(!uid) continue;
      await deletePositions(db,doc.ref);
      const credentialId=String(data.terminalCredentialId||'').trim();
      if(credentialId) await db.collection('terminalCredentials').doc(credentialId).delete().catch(()=>{});
      await db.collection('users').doc(uid).collection('challengeAccounts').doc(accountId).delete().catch(()=>{});
      const selectedRef=db.collection('users').doc(uid).collection('trading').doc('account');
      const selected=await selectedRef.get();
      if(selected.exists && String(selected.data()?.accountId||'')===accountId) await selectedRef.delete().catch(()=>{});
      await doc.ref.delete();
      console.log(`[breach-retention] deleted ${accountId} after 7 days`);
    }
  }catch(e){
    console.warn('[breach-retention] cleanup failed:',e?.message||e);
  }
}

setTimeout(cleanup,5000);
setInterval(cleanup,INTERVAL_MS);
