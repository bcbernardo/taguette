Translating LibreQDA
====================

LibreQDA is being used globally. Therefore, it needs to be translatable into multiple languages.

What should be translated:

* All the text that is visible on web pages during normal usage (templates, messages, JavaScript messages)
* The messages printed to the terminal and the command-line help

What should NOT be translated:

* Logging and exception messages (those are really destined to developers)
* API messages and errors

There are two catalogs: `main` is used by the server, and `javascript` is loaded client-side as JSON to be used by the JavaScript code. After changes to the source code, you should run the script `scripts/update_pot.sh`. It will extract and updates the `msgid` strings. Obsolete messages will be marked with  `#~`.

Run the script `scripts/update_translations.sh` before and after updating PO files. It will update the POT catalogs with the changes from the code and also generate the MO files from the translated PO files.

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
