import json
import os
import tempfile
import unittest

from taguette.access_control import (check_access,
                                     load_rules,
                                     get_role_from_rule)


class TestCheckAccess(unittest.TestCase):

    def _allowed(self, rules, user_infos):
        return check_access(rules, user_infos)['allowed']

    def test_no_rules_allows_everyone(self):
        rules = {'whitelist': [], 'blacklist': []}
        self.assertTrue(self._allowed(rules,
                                      {'email': 'anyone@example.com',
                                       'edugain.code': ''}))

    def test_empty_email_denied(self):
        rules = {'whitelist': [], 'blacklist': []}
        self.assertFalse(self._allowed(rules,
                                       {'email': '', 'edugain.code': ''}))
        self.assertFalse(self._allowed(rules, None))

    # --- Domain rules ---

    def test_domain_whitelist(self):
        rules = {
            'whitelist': [{'type': 'domain', 'pattern': '@usherbrooke.ca'}],
            'blacklist': [],
        }
        self.assertTrue(self._allowed(rules,
                                      {'email': 'prof@usherbrooke.ca',
                                       'edugain.code': ''}))
        self.assertFalse(self._allowed(rules,
                                       {'email': 'prof@gmail.com',
                                        'edugain.code': ''}))

    def test_domain_blacklist(self):
        rules = {
            'whitelist': [],
            'blacklist': [{'type': 'domain', 'pattern': '@spam.com'}],
        }
        self.assertFalse(self._allowed(rules,
                                       {'email': 'user@spam.com',
                                        'edugain.code': ''}))
        self.assertTrue(self._allowed(rules,
                                      {'email': 'user@gmail.com',
                                       'edugain.code': ''}))

    # --- Domain rules ---

    def test_edugain_whitelist(self):
        rules = {
            'whitelist': [{'type': 'edugain.code', 'pattern': 'CAF'}],
            'blacklist': [],
        }
        self.assertTrue(self._allowed(rules,
                                      {'email': 'prof@usherbrooke.ca',
                                       'edugain.code': 'CAF'}))
        self.assertFalse(self._allowed(rules,
                                       {'email': 'prof@gmail.com',
                                        'edugain.code': ''}))

    def test_edugain_blacklist(self):
        rules = {
            'whitelist': [],
            'blacklist': [{'type': 'edugain.code', 'pattern': 'CAF'}],
        }
        self.assertFalse(self._allowed(rules,
                                       {'email': 'user@spam.com',
                                        'edugain.code': 'CAF'}))
        self.assertTrue(self._allowed(rules,
                                      {'email': 'user@gmail.com',
                                       'edugain.code': ''}))

    # --- Email exact rules ---

    def test_email_whitelist(self):
        rules = {
            'whitelist': [{'type': 'email', 'pattern': 'guest@gmail.com'}],
            'blacklist': [],
        }
        self.assertTrue(self._allowed(rules,
                                      {'email': 'guest@gmail.com',
                                       'edugain.code': ''}))
        self.assertFalse(self._allowed(rules,
                                       {'email': 'other@gmail.com',
                                        'edugain.code': ''}))

    def test_email_case_insensitive(self):
        rules = {
            'whitelist': [{'type': 'email', 'pattern': 'Guest@Gmail.com'}],
            'blacklist': [],
        }
        self.assertTrue(self._allowed(rules,
                                      {'email': 'guest@gmail.com',
                                       'edugain.code': ''}))
        self.assertTrue(self._allowed(rules,
                                      {'email': 'GUEST@GMAIL.COM',
                                       'edugain.code': ''}))

    # --- Wildcard rules ---

    def test_wildcard_whitelist(self):
        rules = {
            'whitelist': [{'type': 'wildcard', 'pattern': '*@usherbrooke.ca'}],
            'blacklist': [],
        }
        self.assertTrue(self._allowed(rules,
                                      {'email': 'anyone@usherbrooke.ca',
                                       'edugain.code': ''}))
        self.assertFalse(self._allowed(rules,
                                       {'email': 'anyone@gmail.com',
                                        'edugain.code': ''}))

    def test_wildcard_blacklist(self):
        rules = {
            'whitelist': [{'type': 'domain', 'pattern': '@usherbrooke.ca'}],
            'blacklist': [
                {'type': 'wildcard', 'pattern': 'bot*@usherbrooke.ca'}
            ],
        }
        # Both match -> whitelist wins on pattern conflict
        self.assertTrue(self._allowed(rules,
                                      {'email': 'bot123@usherbrooke.ca',
                                       'edugain.code': ''}))
        self.assertTrue(self._allowed(rules,
                                      {'email': 'prof@usherbrooke.ca',
                                       'edugain.code': ''}))

    # --- Regex rules ---

    def test_regex_blacklist(self):
        rules = {
            'whitelist': [{'type': 'domain', 'pattern': '@usherbrooke.ca'}],
            'blacklist': [
                {'type': 'regex', 'pattern': 'test.*@usherbrooke\\.ca'}
            ],
        }
        # Both match -> whitelist wins on pattern conflict
        self.assertTrue(self._allowed(rules,
                                      {'email': 'test123@usherbrooke.ca',
                                       'edugain.code': ''}))
        self.assertTrue(self._allowed(rules,
                                      {'email': 'prof@usherbrooke.ca',
                                       'edugain.code': ''}))

    def test_regex_blacklist_only(self):
        rules = {
            'whitelist': [],
            'blacklist': [
                {'type': 'regex', 'pattern': 'test.*@usherbrooke\\.ca'}
            ],
        }
        self.assertFalse(self._allowed(rules,
                                       {'email': 'test123@usherbrooke.ca',
                                        'edugain.code': ''}))
        self.assertTrue(self._allowed(rules,
                                      {'email': 'prof@usherbrooke.ca',
                                       'edugain.code': ''}))

    def test_invalid_regex_ignored(self):
        rules = {
            'whitelist': [],
            'blacklist': [{'type': 'regex', 'pattern': '[invalid'}],
        }
        self.assertTrue(self._allowed(rules,
                                      {'email': 'user@example.com',
                                       'edugain.code': ''}))

    # --- Priority: exact > pattern ---

    def test_exact_whitelist_wins_over_exact_blacklist(self):
        rules = {
            'whitelist': [{'type': 'email', 'pattern': 'msat@usherbrooke.ca'}],
            'blacklist': [{'type': 'email', 'pattern': 'msat@usherbrooke.ca'}],
        }
        self.assertTrue(self._allowed(rules,
                                      {'email': 'msat@usherbrooke.ca',
                                       'edugain.code': ''}))

    def test_exact_whitelist_wins_over_pattern_blacklist(self):
        rules = {
            'whitelist': [{'type': 'email', 'pattern': 'vip@spam.com'}],
            'blacklist': [{'type': 'domain', 'pattern': '@spam.com'}],
        }
        self.assertTrue(self._allowed(rules,
                                      {'email': 'vip@spam.com',
                                       'edugain.code': ''}))
        self.assertFalse(self._allowed(rules,
                                       {'email': 'other@spam.com',
                                        'edugain.code': ''}))

    def test_exact_blacklist_wins_over_pattern_whitelist(self):
        rules = {
            'whitelist': [{'type': 'domain', 'pattern': '@usherbrooke.ca'}],
            'blacklist': [
                {'type': 'email', 'pattern': 'banned@usherbrooke.ca'}
            ],
        }
        self.assertFalse(self._allowed(rules,
                                       {'email': 'banned@usherbrooke.ca',
                                        'edugain.code': ''}))
        self.assertTrue(self._allowed(rules,
                                      {'email': 'prof@usherbrooke.ca',
                                       'edugain.code': ''}))

    # --- Default behavior ---

    def test_whitelist_only_denies_unmatched(self):
        rules = {
            'whitelist': [{'type': 'domain', 'pattern': '@usherbrooke.ca'}],
            'blacklist': [],
        }
        self.assertFalse(self._allowed(rules,
                                       {'email': 'user@hotmail.com',
                                        'edugain.code': ''}))

    def test_blacklist_only_allows_unmatched(self):
        rules = {
            'whitelist': [],
            'blacklist': [{'type': 'domain', 'pattern': '@spam.com'}],
        }
        self.assertTrue(self._allowed(rules,
                                      {'email': 'user@gmail.com',
                                       'edugain.code': ''}))

    # --- Scénario ticket: wildcard whitelist + exact blacklist ---

    def test_wildcard_allow_all_except_one(self):
        rules = {
            'whitelist': [{'type': 'wildcard', 'pattern': '*'}],
            'blacklist': [{'type': 'email', 'pattern': 'msat@usherbrooke.ca'}],
        }
        self.assertFalse(self._allowed(rules,
                                       {'email': 'msat@usherbrooke.ca',
                                        'edugain.code': ''}))
        self.assertTrue(self._allowed(rules,
                                      {'email': 'other@usherbrooke.ca',
                                       'edugain.code': ''}))

    # --- Return dict ---

    def test_returns_reason(self):
        rules = {
            'whitelist': [{'type': 'email', 'pattern': 'vip@test.com'}],
            'blacklist': [],
        }
        result = check_access(rules,
                              {'email': 'vip@test.com', 'edugain.code': ''})
        self.assertTrue(result['allowed'])
        self.assertEqual(result['reason'], 'exact_whitelist')
        self.assertEqual(result['matched_rule']['pattern'], 'vip@test.com')

    def test_returns_denied_reason(self):
        rules = {
            'whitelist': [{'type': 'domain', 'pattern': '@usherbrooke.ca'}],
            'blacklist': [],
        }
        result = check_access(rules,
                              {'email': 'user@hotmail.com',
                               'edugain.code': ''})
        self.assertFalse(result['allowed'])
        self.assertEqual(result['reason'], 'not_in_whitelist')

    def test_returns_role(self):
        rules = {
            'whitelist': [{'type': 'email',
                           'pattern': 'vip@test.com',
                           'role': 'PROJECT_ADMIN'}],
            'blacklist': [],
        }
        result = check_access(rules,
                              {'email': 'vip@test.com', 'edugain.code': ''})
        self.assertTrue(get_role_from_rule(result) == "PROJECT_ADMIN")

    def test_returns_invalid_role(self):
        rules = {
            'whitelist': [{'type': 'email',
                           'pattern': 'vip@test.com',
                           'role': 'INVALID_ROLE'}],
            'blacklist': [],
        }
        result = check_access(rules,
                              {'email': 'vip@test.com', 'edugain.code': ''})
        self.assertTrue(get_role_from_rule(result) is None)

    def test_returns_no_role_in_rule(self):
        rules = {
            'whitelist': [{'type': 'email', 'pattern': 'vip@test.com'}],
            'blacklist': [],
        }
        result = check_access(rules,
                              {'email': 'vip@test.com', 'edugain.code': ''})
        self.assertTrue(get_role_from_rule(result) is None)


class TestLoadRules(unittest.TestCase):

    def test_load_valid_file(self):
        data = {
            'whitelist': [{'type': 'domain', 'pattern': '@usherbrooke.ca'}],
            'blacklist': [],
        }
        with tempfile.NamedTemporaryFile(
            mode='w', suffix='.json', delete=False
        ) as f:
            json.dump(data, f)
            f.flush()
            rules = load_rules(f.name)
        os.unlink(f.name)
        self.assertEqual(len(rules['whitelist']), 1)
        self.assertEqual(
            rules['whitelist'][0]['pattern'], '@usherbrooke.ca'
        )

    def test_load_missing_file(self):
        rules = load_rules('/nonexistent/path.json')
        self.assertEqual(
            rules, {'whitelist': [], 'blacklist': []}
        )

    def test_load_invalid_json(self):
        with tempfile.NamedTemporaryFile(
            mode='w', suffix='.json', delete=False
        ) as f:
            f.write('not json')
            f.flush()
            rules = load_rules(f.name)
        os.unlink(f.name)
        self.assertEqual(
            rules, {'whitelist': [], 'blacklist': []}
        )


if __name__ == '__main__':
    unittest.main()
