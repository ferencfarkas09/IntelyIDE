// mongosh script (run by local.sh): loads canonical-EJSON NDJSON files into one database of a throwaway fixture server.
//   env: MLP_DB (database), MLP_DIR (directory of <collection>.ndjson), MLP_COLLS (comma list), MLP_INDEXES=1 (happy indexes)
// Same data as `docker cp` + mongoimport in matrix.sh, but without the database tools (the mongod tarball has none).
const fs = require('fs');
const env = process.env;
const target = db.getSiblingDB(env.MLP_DB);
for (const name of env.MLP_COLLS.split(',')) {
  const lines = fs.readFileSync(`${env.MLP_DIR}/${name}.ndjson`, 'utf8').split('\n').filter(Boolean);
  let batch = [];
  let n = 0;
  for (const line of lines) {
    batch.push(EJSON.parse(line));
    if (batch.length === 2000) { target.getCollection(name).insertMany(batch, { ordered: false }); n += batch.length; batch = []; }
  }
  if (batch.length) { target.getCollection(name).insertMany(batch, { ordered: false }); n += batch.length; }
  print(`loaded ${env.MLP_DB}.${name}: ${n}`);
}
if (env.MLP_INDEXES === '1') {
  target.orders.createIndex({ restaurant: 1, createdAt: -1 });
  target.orders.createIndex({ status: 1 });
  target.customers.createIndex({ restaurant: 1 });
}
