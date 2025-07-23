#!/usr/bin/env python3

import sys
from pathlib import Path
import sass

def compile_scss(theme_name):

    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    static_dir = project_root / "taguette" / "static"
    
    scss_input = static_dir / "scss" / "themes" / theme_name / "theme.scss"
    css_output = static_dir / "css" / "themed.css"
    
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


def main():
    theme = sys.argv[1] if len(sys.argv) > 1 else "default"
    compile_scss(theme)

if __name__ == "__main__":
    main()
