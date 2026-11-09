import functools


def log_calls(fn):
    @functools.wraps(fn)
    def wrapper(*args):
        print("calling", fn.__name__)
        return fn(*args)
    return wrapper


class Inventory:
    """Keeps stock counts. A { brace } in a docstring must not count."""

    def __init__(self):
        self.stock = {}

    @log_calls
    def remove(self, sku, n):
        if self.stock.get(sku, 0) < n:
            raise ValueError("not enough stock")
        self.stock[sku] -= n
        return self.stock[sku]


def report(inv):
    lines = [f"{sku}: {n}" for sku, n in inv.stock.items()]
    return "\n".join(lines)
