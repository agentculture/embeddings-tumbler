// The viewer reads the --tumbler-* properties when it mounts, on every update() and on
// refreshTheme(). It never polls. After changing a property, for example when the page
// switches between light and dark, ask it to read them again.
document.getElementById("space").style.setProperty("--tumbler-accent", "#ff8a65");
viewer.refreshTheme();
