// installs window.stemkit before the desktop renderer boots, so the React app
// runs unchanged on top of the HTTP API
import './api'
import '../renderer/src/main'
