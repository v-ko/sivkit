from typing import TYPE_CHECKING, Any, Callable, Generic, TypeVar

from PySide6.QtCore import Property as _QtProperty

if TYPE_CHECKING:  # pragma: no cover - typing aid
    T = TypeVar("T")

    class TemplatedProperty(property, Generic[T]):
        fget: Callable[[Any], Any] | None
        fset: Callable[[Any, Any], None] | None
        fdel: Callable[[Any], None] | None
        __isabstractmethod__: bool

        def __init__(
            self,
            fget: Callable[[Any], Any] | None = ...,
            fset: Callable[[Any, Any], None] | None = ...,
            fdel: Callable[[Any], None] | None = ...,
            doc: str | None = ...,
        ) -> None: ...
        def __call__(self, func: Callable[[Any], T], /) -> "TemplatedProperty[T]": ...
        def getter(self, fget: Callable[[Any], Any], /) -> "TemplatedProperty[T]": ...
        def setter(
            self, fset: Callable[[Any, Any], None], /
        ) -> "TemplatedProperty[T]": ...
        def deleter(self, fdel: Callable[[Any], None], /) -> "TemplatedProperty[T]": ...
        def __get__(self, instance: Any, owner: type | None = None, /) -> Any: ...
        def __set__(self, instance: Any, value: Any, /) -> None: ...
        def __delete__(self, instance: Any, /) -> None: ...

    def Property(tp: type[T], *args, **kwargs):
        def deco(fget: Callable[[Any], T]) -> TemplatedProperty[T]:
            return TemplatedProperty[T](fget)

        return deco

else:
    Property = _QtProperty
