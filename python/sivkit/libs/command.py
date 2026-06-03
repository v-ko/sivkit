from typing import Callable

import sivkit

log = sivkit.get_logger(__name__)


class Command:

    def __init__(self, function: Callable, title: str, name: str):
        self.function = function
        self.title = title
        self.name = name

    def __repr__(self):
        return f"<Command title={self.title}>"

    def __call__(self, **context):
        log.info(f"COMMAND triggered: {self}")
        self.function(**context)


_commands: dict[str, Command] = {}


def command(title: str, name: str = ""):

    def decorator(function: Callable):
        cmd_name = name or function.__name__
        _command = Command(function, title, cmd_name)
        _commands[cmd_name] = _command
        return _command

    return decorator


def get_commands() -> list[Command]:
    return list(_commands.values())


def get_command(name: str) -> Command | None:
    return _commands.get(name)
