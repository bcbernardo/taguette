# Customizing styles
LibreQDA uses SCSS instead of plain CSS for better modularity and theme management.

## Theme creation
Themes are stored under `taguette/static/scss/themes/<theme_name>.

You can copy the `default` or `example` theme and customize the main variables in `_variables.scss`. They are used throughout the partials in `components/` and `layout/`.

Note: do not edit `themed.css` directly — it’s overwritten on each build.

## Compilation
To compile a theme, run:

``` console
poetry run make-theme <theme_name>
<<<<<<< HEAD
```

## Customizing the logo

Default LibreQDA logos are stored at the following path: `taguette/static/`.

To customize:

1. Add a new logo image under `taguette/static/assets/<theme_name>/`.  
   You need to create a directory for your theme inside `assets/`.

2. In your custom `_variables.scss`, define a new variable `$logo-main` and set it to the path for your new logo:

   ```scss
   $logo-main: "/static/assets/<theme_name>/<your-logo.png>";

3. If the `$logo-main` variable is defined in your `_variables.scss`, it will overwrite the default logo. Otherwise, the default logo will be displayed.

4. You can repeat the same steps for the horizontal version of the logo using the `$logo-horizontal` variable.
=======
```
>>>>>>> 17ca13f (add a readme to the style directory)
