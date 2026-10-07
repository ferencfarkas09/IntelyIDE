// mongosh script (run by local.sh) on the AUTH fixture BEFORE --auth is switched on (localhost, throwaway server).
// Passwords come from the environment (never from the command line): MLP_PW_ROOT, MLP_PW_RO, MLP_PW_RESTRICT, MLP_PW_ANY.
// SCRAM-SHA-256 only. env MLP_DB: the data database for the grants; MLP_DB2: a second one (optional).
const e = process.env;
const admin = db.getSiblingDB('admin');
const mech = ['SCRAM-SHA-256'];
const findOnly = [e.MLP_DB, e.MLP_DB2].filter(Boolean).map((d) => ({ resource: { db: d, collection: 'orders' }, actions: ['find'] }));
admin.createRole({ role: 'ordersFindOnly', privileges: findOnly, roles: [] });
admin.createUser({ user: 'root', pwd: e.MLP_PW_ROOT, roles: [{ role: 'root', db: 'admin' }], mechanisms: mech });
const readRoles = [{ role: 'read', db: e.MLP_DB }];
if (e.MLP_DB2) readRoles.push({ role: 'read', db: e.MLP_DB2 });
admin.createUser({ user: 'ro', pwd: e.MLP_PW_RO, roles: readRoles, mechanisms: mech });
admin.createUser({ user: 'restricted', pwd: e.MLP_PW_RESTRICT, roles: [{ role: 'ordersFindOnly', db: 'admin' }], mechanisms: mech });
admin.createUser({ user: 'anyread', pwd: e.MLP_PW_ANY, roles: [{ role: 'readAnyDatabase', db: 'admin' }], mechanisms: mech });
print('users: ' + admin.getUsers().users.map((u) => u.user).join(','));
