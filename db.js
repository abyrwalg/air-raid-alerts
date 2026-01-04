import Loki from 'lokijs';

const db = new Loki('main.db', {
  autoload: true,
  autoloadCallback: databaseInitialize,
  autosave: true,
  autosaveInterval: 4000, // save every 4 seconds
});

function databaseInitialize() {
  // Create the collection only if it doesn't exist
  let messages = db.getCollection('messages');

  if (messages === null) {
    messages = db.addCollection('messages');
  }

  purgeOldMessages(2);
}

export function purgeOldMessages(days = 2) {
  console.log(`Purging messages older than ${days} days...`);
  const messages = db.getCollection('messages');

  const cutoffIso = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000
  ).toISOString();

  messages
    .chain()
    .find({ createdAt: { $lt: cutoffIso } })
    .remove();
}

setInterval(() => {
  purgeOldMessages(2);
}, 12 * 60 * 60 * 1000); // every 12 hours

export default db;
