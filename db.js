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
}

export function purgeOldMessages(days = 2) {
  const messages = db.getCollection('messages');
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  messages
    .chain()
    .find({ createdAt: { $lt: cutoff } })
    .remove();
}

setInterval(() => {
  purgeOldMessages(2);
}, 12 * 60 * 60 * 1000); // every 12 hours

export default db;
