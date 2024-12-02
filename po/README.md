Translating LibreQDA
====================

LibreQDA is being used globally. Therefore, it needs to be translatable into multiple languages.

What should be translated:

* All the text that is visible on web pages during normal usage (templates, messages, JavaScript messages)
* The messages printed to the terminal and the command-line help

What should NOT be translated:

* Logging and exception messages (those are really destined to developers)
* API messages and errors

There are two catalogs: `main` is used by the server, and `javascript` is loaded client-side as JSON to be used by the JavaScript code. After changes to the source code, you should run the script `scripts/update_pot.sh`.

Run the script `scripts/update_translations.sh` before and after updating PO files. It will update the POT catalogs with the changes from the code and also generate the MO files from the translated PO files.

Using `pybabel update` from the `Babel library` can help to update the `.po` files after changes in the source file and to identify obsolete messages (marked with  `#~`). For example:

`pybabel update -i po/main.pot -l en -o po/main_en_US.po --no-fuzzy-matching` with the flags `-i` for the input, `-l` for the language code (to handle locale-specific formatting or pluralization rules) and `-o` for the output.

Beware of the `#, fuzzy` tag which may result in a failure to identify and translate strings.

Standard mapping
================

This table intends to help standardize the terms used within a language translation, and between different languages. Instead of using `tag` as in some other software, LibreQDA is using `code`.

| English     | French        |
|:------------|:--------------|
| codebook    | arbre de code |
| code        | code          |
| parent code | code parent   |
| child code  | code enfant   |
| highlight   | sélection     |
| account     | profil        |
| settings    | préférences   |
| email       | e-mail        |
