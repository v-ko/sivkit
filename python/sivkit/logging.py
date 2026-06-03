import functools
import logging
import os
import threading
from collections import defaultdict
from typing import Callable


def configure_logging():
    """Configure logging from the LOGLEVEL environment variable.
    Call this once at app startup."""
    level_name = os.environ.get("LOGLEVEL", "ERROR")
    level = getattr(logging, level_name, logging.ERROR)
    logging.basicConfig(level=level)


# Auto-configure on import for backward compatibility
configure_logging()


class BColors:
    HEADER = "\033[95m"
    OKBLUE = "\033[94m"
    OKCYAN = "\033[96m"
    OKGREEN = "\033[92m"
    WARNING = "\033[93m"
    FAIL = "\033[91m"
    ENDC = "\033[0m"
    BOLD = "\033[1m"
    UNDERLINE = "\033[4m"


_function_call_stack_per_thread = defaultdict(list)


def traced(logger: logging.Logger):
    """Decorator factory that traces function calls at DEBUG level.

    Produces indented call-stack output with colored function names,
    showing arguments and return values per thread.

    Usage:
        import logging
        from sivkit.logging import traced

        log = logging.getLogger(__name__)

        @traced(log)
        def my_function(foo):
            log.info('doing stuff')
            return foo
    """

    def decorator(func: Callable):
        if not logger.isEnabledFor(logging.DEBUG):
            return func

        name = f"{logger.name}.{func.__name__}"
        name_str = f"{logger.name}.{BColors.OKBLUE}{func.__name__}{BColors.ENDC}"
        trace_log = logging.getLogger("TRACE")

        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            thread_id = threading.get_ident()
            _function_call_stack_per_thread[thread_id].append(name)

            stack_depth = len(_function_call_stack_per_thread[thread_id])
            indent = "." * 4 * (stack_depth - 1)

            args_string = ", ".join(str(a) for a in args)
            kwargs_string = ", ".join(f"{k}={v}" for k, v in kwargs.items())

            msg = (
                f"{indent}CALL: {name_str} "
                f"ARGS=*({args_string}) KWARGS=**{{{kwargs_string}}}"
            )
            trace_log.debug(msg)

            result = func(*args, **kwargs)

            popped_name = _function_call_stack_per_thread[thread_id].pop()
            if popped_name != name:
                raise Exception("Stack continuity error")

            trace_log.debug(f"{indent}END:  {name_str} -> {result}")

            return result

        return wrapper

    return decorator
