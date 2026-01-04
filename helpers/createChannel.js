import processMessage from './processMessage.js';

const pollMessages = (channel, client) => {
  let timer = null;

  const pollHandler = async () => {
    if (channel._polling) {
      return;
    }
    channel._polling = true;

    try {
      const { entity } = channel;
      let messages;

      if (!channel.initialized) {
        messages = await client.getMessages(entity, { limit: 1 });
      } else {
        messages = await client.getMessages(entity, {
          limit: 5,
          minId: channel.lastMessageId,
        });
      }

      if (messages.length > 0) {
        // On first run, just set the lastMessageId without processing (we only want new messages)
        if (!channel.initialized) {
          channel.lastMessageId = messages[0].id.valueOf();
          channel.initialized = true;
          return;
        }

        channel.lastMessageId = messages[0].id.valueOf();

        for (const message of messages.reverse()) {
          await processMessage(message, channel, 'poll');
        }
      }
    } catch (error) {
      console.error(
        `Error fetching messages from ${channel.entity.username}:`,
        error
      );
      if (timer) {
        clearInterval(timer);

        if (!channel._locked) {
          channel._locked = true;
          setTimeout(() => {
            timer = pollMessages(channel, client);
            channel.poller = timer;
            channel._locked = false;
          }, 60 * 1000); // Retry after 1 minute
        }
      }
    } finally {
      channel._polling = false;
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
      initialized: false,
      _locked: false,
      _polling: false,
    };

    channel.poller = pollMessages(channel, client);

    console.log(`Listening to: @${name}`);

    return channel;
  } catch (error) {
    console.error(`Failed to resolve channel ${name}:`, error);
    return null;
  }
}
