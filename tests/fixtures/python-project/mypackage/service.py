"""Service module — fixture for parser tests.

Covers classes, methods, decorators, type hints, and async functions.
"""

from __future__ import annotations

import asyncio
import os
from abc import ABC, abstractmethod
from typing import Optional, List
from .utils import helper as _helper
from ..external import something  # nonexistent relative — resolver should miss

__all__ = ["UserService", "BaseService", "validate_email", "VERSION"]

VERSION: str = "1.0.0"
_INTERNAL: int = 42


class BaseService(ABC):
    """Abstract base class for services."""

    name: str
    _config: dict

    def __init__(self, name: str) -> None:
        self.name = name
        self._config = {}

    @abstractmethod
    def start(self) -> None:
        """Start the service."""
        ...


class UserService(BaseService):
    """Concrete user service with async operations."""

    def __init__(self, name: str, db_url: str = "sqlite:///:memory:") -> None:
        super().__init__(name)
        self.db_url = db_url

    async def get_user(self, user_id: int) -> Optional[dict]:
        """Fetch a user by ID."""
        await asyncio.sleep(0)
        return {"id": user_id}

    async def create_user(self, name: str, email: Optional[str] = None) -> dict:
        """Create a new user."""
        return {"name": name, "email": email}

    @staticmethod
    def hash_password(pw: str) -> str:
        return pw[::-1]

    @classmethod
    def from_env(cls) -> "UserService":
        return cls(os.environ.get("SERVICE_NAME", "default"))

    @property
    def display_name(self) -> str:
        return self.name.title()

    def start(self) -> None:
        pass

    def _private_helper(self) -> None:
        """This should not appear in exports (leading underscore)."""
        pass


def validate_email(email: str) -> bool:
    """Validate an email address.

    Naive check — just looks for @ and a dot.
    """
    return "@" in email and "." in email


async def fetch_all(*ids: int, batch_size: int = 10, **kwargs) -> List[dict]:
    """Fetch all users by ID."""
    return []


def _private_func() -> None:
    """Should not appear in exports."""
    pass
