#!/usr/bin/env python3

import os
import shutil
import sys
from pathlib import Path
import sass

script_dir = Path(__file__).parent
project_root = script_dir.parent
static_dir = project_root / "taguette" / "static"
templates_dir = project_root / "taguette" / "templates"


def get_theme_dir(theme_name):
    return static_dir / "scss" / "themes" / theme_name


def get_template_dir(theme_name):
    return templates_dir / "alt_templates" / theme_name


def get_assets_dir(theme_name):
    return static_dir / "alt_templates" / theme_name


def compile_scss(theme_name):
    theme_dir = get_theme_dir(theme_name)
    scss_input = theme_dir / "theme.scss"
    css_output = theme_dir / "theme.css"
    
    if not scss_input.exists():
        print(f"Error: input SCSS not found: {scss_input}")
        sys.exit(1)
    
    css_output.parent.mkdir(exist_ok=True)
    
    try:
        css, src_map = sass.compile(
            filename=str(scss_input),
            output_style="compressed",
            source_map_filename=str(css_output) + ".map"
        )

        with open(css_output, "w") as f:
            f.write(css)
        
        with open(str(css_output) + ".map", "w") as f:
            f.write(src_map)

        print(f"Successfully compiled {scss_input} to {css_output}")

    except sass.CompileError as e:
        print(f"SCSS compilation error: {e}")
        sys.exit(1)


def copy_default_theme(destination_theme_name):
    from_theme_dir = get_theme_dir("default")
    to_theme_dir = get_theme_dir(destination_theme_name)
    shutil.copytree(from_theme_dir, to_theme_dir, dirs_exist_ok=True)
    return destination_theme_name


def create_directories(theme_name):
    theme_dir = get_theme_dir(theme_name)
    template_dir = get_template_dir(theme_name)
    assets_dir = get_assets_dir(theme_name)
    if not os.path.exists(theme_dir):
        os.makedirs(theme_dir, exist_ok=True)
        copy_default_theme(theme_name)
        print(f"Theme directory created : {theme_dir}")
    else:
        print(f"Theme directory already exists : {theme_dir}")

    if not os.path.exists(template_dir):
        os.makedirs(template_dir, exist_ok=True)
        print(f"Templates directory created : {template_dir}")
    else:
        print(f"Templates directory already exists : {template_dir}")

    if not os.path.exists(assets_dir):
        os.makedirs(assets_dir, exist_ok=True)
        print(f"Assets directory created : {assets_dir}")
    else:
        print(f"Assets directory already exists : {assets_dir}")


def main():
    theme = sys.argv[1] if len(sys.argv) > 1 else "default"
    create_directories(theme)
    compile_scss(theme)


if __name__ == "__main__":
    main()
