from ragger.conftest import configuration

configuration.OPTIONAL.BACKEND_SCOPE = "function"
pytest_plugins = ("ragger.conftest.base_conftest",)
