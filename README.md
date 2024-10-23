
_We are building on the work of [Taguette](https://www.taguette.org/) — go check them out! You will find close alignments between our code bases and even the installation instructions._


LibreQDA
========

LibreQDA is developed by the [Plateforme en humanités numériques (PhuN)](https://www.usherbrooke.ca/flsh/recherche/centres-groupes-et-equipes-de-recherche/phun) at Université de Sherbrooke. 

This qualitative data analysis software (QDA) allows you to:

+ Import PDFs, Word documents (`.docx`), text files (`.txt`), HTML, EPUB, MOBI, Open Documents (`.odt`), and Rich Text Files (`.rtf`).
+ Highlight words, sentences or paragraphs and tag them with codes you create.
+ Create hierarchical relations between your codes.
+ Retrieve your tagged documents and lists of encoded sentences.
+ Export you material in various formats for diffusion or post-processing with other tools.

[Visit our website to consult the documentation.](https://aide.libreqda.org/)

Motivation and Goal
-------------------

Through its collaborations with research teams and non-profit organizations across various fields, the team at PHuN has come to recognize the crucial need for developing rich, resilient and responsive ecosystem of open-source QDA software. Numerous testimonies highlight the disconnect between the commercial incentives of proprietary software and the core theories of substantive qualitative analysis. Today, users of QDA are subjected to forced obsolescence, costly licenses, black box features and restrictions that prevent them from fully owning with their intellectual product.

Our goal is to position LibreQDA as a valuable component within a diverse array of resources available to users seeking to develop a rich understanding of their textual data. We are committed to continuous improvement through community feedback and advocate for open integration with other tools to best meet your needs.

If you think LibreQDA could do something better, reach out!

Installation
------------

You can find complete installation instructions on [our website](https://www.taguette.org/install.html), including installers for Windows and MacOS.

Development setup from the repository
-------------------------------------

You can install from a local clone of this repository, which will allow you to easily change the sources to suit your needs:

1. Clone this git repository from the terminal: `git clone [UPDATE WITH THE CORRECT REPO]`
2. Navigate on the command line to the repository you've just cloned locally, using the `cd` command. To get help using `cd`, use [this tutorial](https://swcarpentry.github.io/shell-novice/02-filedir/index.html).
3. LibreQDA uses [Poetry](https://python-poetry.org/) for its packaging and dependency management. You will need to [install Poetry](https://python-poetry.org/docs/#installation).
4. Install LibreQDA and its dependencies by running `poetry install`. Poetry will create a virtual environment for you by default, activate it by running `poetry shell`.
5. Build translation files using `scripts/update_translations.sh`.
6. You can start LibreQDA in development mode using `taguette --debug` (or `taguette --debug server <config_file>`). This will start Tornado in debug mode, which means in particular that it will auto-restart every time you make changes. 
   1. A config file can be created by running `taguette default-config > taguette.conf`
7. Navigate to [localhost:7465](http://localhost:7465/) to use LibreQDA!

License
-------
* Copyright (c) 2023, Plateforme en humanités numériques (Université de Sherbrooke) and contributors
* Copyright (c) 2018, Remi Rampin and Taguette contributors

Licensed under a **BSD 3-clause "New" or "Revised" License**. See the `LICENSE.txt` file for details.