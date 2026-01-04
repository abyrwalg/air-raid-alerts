import processMessage from './processMessage.js';

const pollMessages = (channel, client) => {
  channel.initialized = false;
  let timer = null;

  const pollHandler = async () => {
    try {
      const { entity } = channel;

      const messages = await client.getMessages(entity, { limit: 5 });
      if (messages.length > 0) {
        // On first run, just set the lastMessageId without processing (we only want new messages)
        if (!channel.initialized) {
          channel.lastMessageId = messages[0].id.valueOf();
          channel.initialized = true;
          return;
        }

        const messagesToProcess = messages.filter(
          (msg) =>
            !channel.lastMessageId || msg.id.valueOf() > channel.lastMessageId
        );

        channel.lastMessageId = messages[0].id.valueOf();

        for (const message of messagesToProcess.reverse()) {
          await processMessage(message, channel, 'poll');
        }
      } else {
        console.log(`No messages found in ${entity.username}`);
      }
    } catch (error) {
      console.error(
        `Error fetching messages from ${channel.entity.username}:`,
        error
      );
      if (timer) {
        clearInterval(timer);

        setTimeout(() => {
          timer = pollMessages(channel, client);
        }, 60 * 1000); // Retry after 1 minute
      }
    }
  };

  pollHandler().catch((error) => {
    console.error('Initial poll error:', error);
  }); // Initial poll
  timer = setInterval(pollHandler, 20 * 1000); // Poll every 20 seconds

  return timer;
};

export default async function createChannel(name, client) {
  try {
    const entity = await client.getEntity(name);

    const channel = {
      id: entity.id.valueOf(),
      name,
      entity,
    };

    channel.poller = pollMessages(channel, client);

    console.log(`Listening to: @${name}`);

    return channel;
  } catch (error) {
    console.error(`Failed to resolve channel ${name}:`, error);
    return null;
  }
}
