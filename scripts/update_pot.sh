#!/bin/sh

set -eu

cd "$(dirname "$(dirname "$0")")"
pybabel extract -F scripts/babelrc -k _f -c TRANSLATORS: -s -o po/main.pot $(find taguette -name '*.py' -o -name '*.html')
pybabel extract -F scripts/babelrc -c TRANSLATORS: -s -o po/javascript.pot $(find taguette -name '*.js')

LOCALES=$(ls po/main_*.po 2>/dev/null | sed 's/.*main_\(.*\)\.po/\1/' | sort -u || echo "")

if [ -z "$LOCALES" ]; then
    echo "No existing .po files found. Skipping update."
    exit 0
fi

echo ""
echo "Found locales: $LOCALES"

# Update main catalogue
echo ""
echo "Updating main catalogue..."
for locale in $LOCALES; do
    echo "  - $locale"
    pybabel update -i po/main.pot -l $locale -o po/main_${locale}.po --no-fuzzy-matching
done

# Update javascript catalogue
echo ""
echo "Updating javascript catalogue..."
for locale in $LOCALES; do
    echo "  - $locale"
    pybabel update -i po/javascript.pot -l $locale -o po/javascript_${locale}.po --no-fuzzy-matching
done