import fnmatch
import json
import logging
import re

logger = logging.getLogger(__name__)

VALID_LIST_TYPES = ('whitelist', 'blacklist')
VALID_RULE_TYPES = ('email', 'domain', 'wildcard', 'regex')


def load_rules(filepath):
    try:
        with open(filepath, 'r') as f:
            data = json.load(f)
        return {
            'whitelist': data.get('whitelist', []),
            'blacklist': data.get('blacklist', []),
        }
    except FileNotFoundError:
        logger.warning("Access rules file not found: %s", filepath)
        return {'whitelist': [], 'blacklist': []}
    except json.JSONDecodeError as e:
        logger.error("Invalid JSON in access rules file: %s", e)
        return {'whitelist': [], 'blacklist': []}


def _matches_pattern(email, rule):
    pattern = rule['pattern'].lower().strip()
    rule_type = rule['type']
    try:
        if rule_type == 'domain':
            return email.endswith(pattern)
        elif rule_type == 'wildcard':
            return fnmatch.fnmatch(email, pattern)
        elif rule_type == 'regex':
            return bool(re.fullmatch(pattern, email))
        elif rule_type == 'email':
            return email == pattern
    except re.error:
        logger.error("Invalid regex in access rule: '%s'", rule['pattern'])
    return False


def check_access(rules, email):
    # Priority: exact whitelist > exact blacklist
    # > pattern (whitelist wins on conflict)
    if not email:
        return {'allowed': False, 'reason': 'no_email', 'matched_rule': None}

    email = email.lower().strip()
    whitelist = rules.get('whitelist', [])
    blacklist = rules.get('blacklist', [])

    if not whitelist and not blacklist:
        return {'allowed': True, 'reason': 'no_rules', 'matched_rule': None}

    exact_whitelist = []
    exact_blacklist = []
    pattern_whitelist = []
    pattern_blacklist = []

    for rule in whitelist:
        is_exact = rule['type'] == 'email' and rule['pattern'].lower() == email
        if is_exact:
            exact_whitelist.append(rule)
        elif _matches_pattern(email, rule):
            pattern_whitelist.append(rule)

    for rule in blacklist:
        is_exact = rule['type'] == 'email' and rule['pattern'].lower() == email
        if is_exact:
            exact_blacklist.append(rule)
        elif _matches_pattern(email, rule):
            pattern_blacklist.append(rule)

    # 1. Exact whitelist wins over everything
    if exact_whitelist:
        logger.info("Access ALLOWED for %s: exact whitelist '%s'",
                    email, exact_whitelist[0]['pattern'])
        return {'allowed': True, 'reason': 'exact_whitelist',
                'matched_rule': exact_whitelist[0]}

    # 2. Exact blacklist wins over pattern matches
    if exact_blacklist:
        logger.info("Access DENIED for %s: exact blacklist '%s'",
                    email, exact_blacklist[0]['pattern'])
        return {'allowed': False, 'reason': 'exact_blacklist',
                'matched_rule': exact_blacklist[0]}

    # 3. Pattern conflict: whitelist wins
    if pattern_whitelist and pattern_blacklist:
        logger.info("Access ALLOWED for %s: whitelist priority '%s'",
                    email, pattern_whitelist[0]['pattern'])
        return {'allowed': True, 'reason': 'pattern_whitelist_priority',
                'matched_rule': pattern_whitelist[0]}

    # 4. Single pattern match
    if pattern_whitelist:
        logger.info("Access ALLOWED for %s: pattern whitelist '%s'",
                    email, pattern_whitelist[0]['pattern'])
        return {'allowed': True, 'reason': 'pattern_whitelist',
                'matched_rule': pattern_whitelist[0]}

    if pattern_blacklist:
        logger.info("Access DENIED for %s: pattern blacklist '%s'",
                    email, pattern_blacklist[0]['pattern'])
        return {'allowed': False, 'reason': 'pattern_blacklist',
                'matched_rule': pattern_blacklist[0]}

    # 5. No match — if whitelist rules exist, deny (whitelist = allow-only)
    if whitelist:
        logger.info("Access DENIED for %s: not in whitelist", email)
        return {'allowed': False, 'reason': 'not_in_whitelist',
                'matched_rule': None}

    logger.info("Access ALLOWED for %s: no matching rule", email)
    return {'allowed': True, 'reason': 'default', 'matched_rule': None}

def get_role_from_rule(rule):
    if rule is not None and 'role' in rule:
        role = rule['role']
        if role in ['ADMIN',
                    'PROJECT_ADMIN',
                    'TEAM_MEMBER',
                    'PROJECT_OWNER']:
            return role
    return None
