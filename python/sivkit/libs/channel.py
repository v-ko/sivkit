"""It supports adding named channels on which to subscribe handlers and then
dispatch messages (which are arbitrary python objects).

Dispatching and invoking the handlers are both done on the same thread, so
it's expected that the subscribed callables are light, since the main purpose
of sivkit is GUI rendering and blocking the main loop would cause freezing.
"""

from collections import defaultdict
from dataclasses import MISSING
from typing import Any, Callable, Dict

import sivkit
from sivkit import get_logger

log = get_logger(__name__)

_channels = {}


def unsibscribe_all():
    for channel_name, channel in _channels.items():
        for sub_props, sub in list(channel.subscriptions.items()):
            sub.unsubscribe()


class Subscription:

    def __init__(self, handler, channel, index_val: Any = MISSING):
        self.id = id(self)
        self.handler = handler
        self.channel = channel
        self.index_val = index_val

    def props(self):
        return self.handler, self.channel, self.index_val

    def unsubscribe(self):
        self.channel.remove_subscribtion(self)


class Channel:

    def __init__(
        self,
        name: str,
        subchannel: Callable | None = None,
        subchannel_classifier: Callable | None = None,
    ):
        self.name = name
        self.subchannel = subchannel
        self.subchannel_classifier = subchannel_classifier
        # self.message_stack = []
        self.subscriptions: Dict[tuple, Subscription] = {}  # by id

        # if subchannel:
        self.subs_index = defaultdict(list)  # Subscriptions by index_val
        self.non_indexed_subs = []  # Subscriptions without index_val

        if name in _channels:
            raise Exception("A channel with this name already exists")
        _channels[name] = self

    def __repr__(self):
        return f"<Channel name={self.name}>"

    @log.traced
    def push(self, message):
        if self.subchannel_classifier:
            if not self.subchannel_classifier(message):
                return

        # self.message_stack.append(message)
        # call_delayed(self.notify_subscribers)
        # !!! NO, this way messages get batched by channel and
        # the order is lost

        # # log.info('^^PUSH^^ on "%s": %s' % (self.name, message))

        #

        for sub_props, sub in self.subscriptions.items():
            if self.subchannel and sub.index_val is not MISSING:
                if self.subchannel(message) != sub.index_val:
                    continue

            # log.info(f'Queueing {sub.handler=} for {message=} on'
            #          f' channel_name={self.name}')
            sivkit.call_delayed(sub.handler, 0, args=[message])

    def subscribe(self, handler: Callable, index_val: Any = MISSING):
        sub = Subscription(handler, _channels[self.name], index_val)
        self.add_subscribtion(sub)
        return sub

    def add_subscribtion(self, subscribtion):
        if subscribtion.props() in self.subscriptions:
            raise Exception(
                f"Subscription with props {subscribtion.props()} "
                f"already added to channel "
                f"{self.name}"
            )

        self.subscriptions[subscribtion.props()] = subscribtion

    def remove_subscribtion(self, subscribtion):
        if subscribtion.props() not in self.subscriptions:
            raise Exception(
                f"Cannot unsubscribe missing subscription with props"
                f" {subscribtion.props()}"
                f" in channel {self.name}"
            )

        self.subscriptions.pop(subscribtion.props())

    # def notify_subscribers(self):
    # !!! NO, this way messages get batched by channel and the order is lost
    #     if not self.message_stack:
    #         return

    #     # # Iterate over a copy of the subscriptions, since an additional handler
    #     # # can get added while executing the present handlers
    #     # for sub_props, sub in copy(self.subscriptions).items():
    #     #     # If the channel is not indexed or the subscriber does not filter
    #     #     # messages using the index - notify for all messages
    #     #     if not self.subchannel or sub.filter_val is MISSING:
    #     #         messages = self.message_stack
    #     #     else:
    #     #         messages = self.index.get(sub.filter_val, [])

    #     #     for message in messages:
    #     #         log.info(f'Calling {sub.handler=} for {message=} on'
    #     #                  f' channel_name={sub.channel_name}')
    #     #         sub.handler(message)

    #     for message in copy(self.message_stack):
    #         # Copy the subscriptions we iterate over, because the list can
    #         # change while executing the actions and we don't want that
    #         for sub_props, sub in copy(self.subscriptions).items():
    #             if self.subchannel and sub.index_val is not MISSING:
    #                 if self.subchannel(message) != sub.index_val:
    #                     continue

    #             log.info(f'Calling {sub.handler=} for {message=} on'
    #                      f' channel_name={self.name}')
    #             call_delayed(sub.handler, 0, args=[message])
    #             # !!!! sub.handler(message)
    #     self.message_stack.clear()
    #     # self.index.clear()
