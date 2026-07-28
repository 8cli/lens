"""pytest configuration for Aperture tests."""

import os

os.environ["API_KEY"] = "sk-test"
os.environ["DEFAULT_MODEL"] = "test-model"
os.environ["UPSTREAM_BASE_URL"] = "http://localhost:99999"

