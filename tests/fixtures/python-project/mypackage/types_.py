"""Type aliases — fixture for PEP 695 type statement parsing."""

from typing import Union

# Plain assignment alias (legacy)
UserId = int

# PEP 695 type alias (Python 3.12+)
type Email = str
type MaybeUser = Union[dict, None]
