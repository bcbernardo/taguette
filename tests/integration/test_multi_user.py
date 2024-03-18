from .test_user_base import TestUserBase


class TestMultiUser(TestUserBase):
    # Multi-user specific configurations
    multiuser = True
    cookies_prompt = True
    secret_key = 'single_user_secret_long_and_strong'
    xsrf_cookies = True
