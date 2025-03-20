from tornado.testing import gen_test
from tornado.escape import url_escape
from .test_multi_user import TestMultiUser


class TestMultiUserLoginExternal(TestMultiUser):
    def generate_config(self):

        config = super().generate_config()

        config.update({
            'ALLOW_EXTERNAL_LOGIN': True,
            'OAUTH_CLIENT_ID': "cilogon:/client_id/123456789",
            'OAUTH_CLIENT_SECRET': "very-secret-secret",
            'OAUTH_CALLBACK_URL': "http://localhost:7465/ci_callback",
            'OAUTH_AUTH_URI': "https://cilogon.org/authorize",
            'OAUTH_TOKEN_URI': "https://cilogon.org/oauth2/token",
            'OAUTH_USERINFO_URI': "https://cilogon.org/oauth2/userinfo",
            'OAUTH_SCOPE': ['profile', 'email', 'openid',
                            'org.cilogon.userinfo'],
        })

        return config

    def get_app(self):
        return super().get_app()

    @gen_test(timeout=30)
    async def test_login(self):
        # await self.s_get('/register')
        # self.assertIn(
        #     'CILogon',
        #     [el.text for el in self.find_by_tag('p')],
        # )
        async with self.aget('/register') as response:
            self.assertEqual(response.status, 200)
            self.assertIn(
                b'CILogon',
                await response.read()
            )

        async with self.aget('/login') as response:
            self.assertEqual(response.status, 200)
            self.assertIn(
                b'CILogon',
                await response.read()
            )

        custom_error_message = "My custom error message"
        error_msg = url_escape(custom_error_message)
        async with self.aget(
            f'/ci_callback?error=error&error_description={error_msg}'
        ) as response:
            self.assertGreaterEqual(response.status, 200)
            self.assertLess(response.status, 400)

        async with self.aget(
            f'/login?error=error&error_msg={error_msg}'
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertIn(
                b'My custom error message',
                await response.read()
            )

        # Url to mock :
        # auth_uri='https://cilogon.org/authorize'
        # token_uri='https://cilogon.org/oauth2/token'
        # userinfo_uri='https://cilogon.org/oauth2/userinfo'

        async with self.aget('/ci_callback') as response:
            # Should redirect with message
            self.assertGreaterEqual(response.status, 200)
            self.assertLess(response.status, 400)

        # Insert in EdugainIdps
        # 	{
        # 		"id" : 34519,
        # 		"entityid" :
        #             "https:\/\/shibboleth.usherbrooke.ca\/idp\/shibboleth",
        # 		"e_displayname" : null,
        # 		"regauth" : "http:\/\/www.canarie.ca",
        # 		"entity_cat" : "11;76",
        # 		"eccs_status" : 4,
        # 		"validator_status" : 0,
        # 		"coco_status" : null,
        # 		"coco_id" : null,
        # 		"sirtfi_status" : 1,
        # 		"code" : "CAF",
        # 		"scopes" : "usherbrooke.ca"
        # 	}

        # Test login existing user
        # code = 'LONG_AUTHORIZATION_CODE'
        # async with self.aget(
        #         f'/ci_callback?code={code}'
        # ) as response:
        #     self.assertEqual(response.status, 200)
        #     # mock.patch
        #     tok = {
        #         "access_token": "VALID_ACCESS_TOKEN"
        #     }
        #     valid_response = {
        #         "sub": "http://cilogon.org/serverE/users/123456789",
        #         "idp_name": "Universit\u00e9 de Sherbrooke",
        #         "eppn": "test@example.com",
        #         "cert_subject_dn": "...",
        #         "eptid": "https://shibboleth.usherbrooke.ca/idp/shibboleth"
        #                  "!https://cilogon.org/shibboleth!123456789",
        #         "iss": "https://cilogon.org",
        #         "given_name": "My complete",
        #         "acr": "https://refeds.org/profile/mfa",
        #         "aud": "cilogon:/client_id/123456789",
        #         "nbf": 1710169491,
        #         "idp": "https://shibboleth.usherbrooke.ca/idp/shibboleth",
        #         "affiliation": "email@example.com",
        #         "name": "My complete Name",
        #         "family_name": "Name",
        #         "email": "test@example.com",
        #         "jti":
        #             "https://cilogon.org/oauth2/idToken/123456789/123456789"
        #     }

        # Test login non-existing user

        # Test login forbidden user
