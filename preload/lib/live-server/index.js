let fs = require('fs'),
  connect = require('connect'),
  serveIndex = require('serve-index'),
  logger = require('morgan'),
  WebSocket = require('faye-websocket'),
  path = require('path'),
  url = require('url'),
  http = require('http'),
  send = require('send'),
  Transform = require('stream').Transform,
  os = require('os'),
  chokidar = require('chokidar')

// 可选依赖懒加载：opn / http-proxy / http-auth / cors / proxy-middleware 只在各自分支里 require
// （open / proxy / htpasswd / cors 参数被使用时）。本插件默认不传 proxy/htpasswd/cors，
// 且 opn 由渲染层用 utools.shellOpenExternal 接管 —— 顶部不再 require，避免加载插件时就拉起
// 整棵可选依赖树（启动耗时与内存占用）。默认参数路径的行为与原实现一致。
//
// 注意：http-auth / cors / proxy-middleware / http-proxy 已在打包时按要求从 preload/package.json
// 裁掉（本目录 package.json 也同步只声明真正会 require 的依赖）。所以下面 4 个功能分支统一改用
// optionalRequire：外部一旦显式传入 htpasswd / cors / proxy 参数，会抛出可读错误，而不是以
// MODULE_NOT_FOUND 的形式崩掉整个 preload。默认路径（不传这些参数）完全不受影响。

/**
 * 加载已被裁剪的可选依赖；缺失时抛出说明性错误。
 * @param {string} pkg 包名
 * @param {string} feature 依赖该包的功能名（写进错误提示）
 */
function optionalRequire(pkg, feature) {
  try {
    return require(pkg)
  } catch (e) {
    var reason = e && e.message ? '（' + e.message + '）' : ''
    throw new Error('Live Server: 当前构建未内置 ' + pkg + '，' + feature + ' 功能不可用' + reason)
  }
}

var INJECTED_CODE = fs.readFileSync(path.join(__dirname, 'injected.html'), 'utf8')

/**
 * 只替换第一个匹配片段的最小 Transform（替代已废弃的 event-stream 的 es.replace）。
 *
 * 为什么自己实现：event-stream 3.x 已停止维护且依赖树大，本文件只用它的「流式首匹配替换」一个能力。
 * 这里按需缓冲 chunk 直到匹配到 tag（HTML 注入标签一定存在于刚检测过的文件里），替换后原样透传剩余数据；
 * 未命中任何 tag 时在 flush 阶段把缓冲区整体输出，不丢内容。
 *
 * @param {string} tag 要替换的第一个标签（如 '</body>'）
 * @param {string} replacement 替换内容（注入脚本 + 原标签）
 */
function replaceFirstTagStream(tag, replacement) {
  var tagBuffer = Buffer.from(tag)
  var buffered = Buffer.alloc(0)
  var replaced = false
  return new Transform({
    transform: function (chunk, encoding, callback) {
      if (replaced) return callback(null, chunk)
      buffered = Buffer.concat([buffered, chunk])
      var index = buffered.indexOf(tagBuffer)
      if (index === -1) return callback()
      replaced = true
      var output = Buffer.concat([
        buffered.subarray(0, index),
        Buffer.from(replacement),
        // 跳过被替换掉的原始 tag（replacement 里已经包含 tag），否则响应体会多出 tag 长度、
        // 与 Content-Length 不一致，浏览器/HTTP 客户端会把它当成下一个响应而报 parse error
        buffered.subarray(index + tagBuffer.length),
      ])
      buffered = Buffer.alloc(0)
      callback(null, output)
    },
    flush: function (callback) {
      if (!replaced && buffered.length > 0) this.push(buffered)
      callback()
    },
  })
}

let useBrowserExtension = false
let GET_INJECTED_CODE = () => {
  return useBrowserExtension === true ? '' : INJECTED_CODE
}

var LiveServer = {
  server: null,
  watcher: null,
  logLevel: 2,
}

function escape(html) {
  return String(html)
    .replace(/&(?!\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Based on connect.static(), but streamlined and with added code injecter
function staticServer(root, onTagMissedCallback) {
  var isFile = false
  try {
    // For supporting mounting files instead of just directories
    isFile = fs.statSync(root).isFile()
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }

  // HTML 注入标签检测缓存：key = 文件绝对路径，value = { mtimeMs, tag }。
  // 历史实现每次 HTML 请求都 fs.readFileSync 整份文件，只为找 </body>/</svg>/</head> 这类标签；
  // 按 mtime 命中时直接复用检测结果、跳过整文件读取（大 HTML / 高刷新频率下收益明显）。
  // 上限 200 条，超限按插入顺序淘汰最旧（FIFO），避免长会话无限增长；缓存随本 staticServer 实例释放。
  var INJECT_CACHE_LIMIT = 200
  var injectCache = new Map()

  return function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    var reqpath = isFile ? '' : url.parse(req.url).pathname
    var hasNoOrigin = !req.headers.origin
    var injectCandidates = [new RegExp('</body>', 'i'), new RegExp('</svg>'), new RegExp('</head>', 'i')]

    // extraInjectCandidates = extraInjectCandidates || [];
    // extraInjectCandidates.forEach(item => {
    // 	injectCandidates.push(new RegExp(`</${item}>`, "i"))
    // });

    var injectTag = null

    function directory() {
      var pathname = url.parse(req.originalUrl).pathname
      res.statusCode = 301
      res.setHeader('Location', pathname + '/')
      res.end('Redirecting to ' + escape(pathname) + '/')
    }

    function file(filepath /*, stat*/) {
      var x = path.extname(filepath).toLocaleLowerCase(),
        match,
        possibleExtensions = ['', '.html', '.htm', '.xhtml', '.php', '.svg']
      if (hasNoOrigin && possibleExtensions.indexOf(x) > -1) {
        // 先查 mtime 缓存：命中则复用上次的检测结果，避免为找注入标签而整文件同步读取
        var cached = injectCache.get(filepath)
        var mtimeMs = 0
        try {
          mtimeMs = fs.statSync(filepath).mtimeMs
        } catch (e) {
          // stat 失败（文件刚被删除/无权限等）时走下面的原同步读取路径，抛错行为与旧实现一致
        }
        if (cached && cached.mtimeMs === mtimeMs) {
          injectTag = cached.tag
        } else {
          // TODO: Sync file read here is not nice, but we need to determine if the html should be injected or not
          var contents = fs.readFileSync(filepath, 'utf8')
          for (var i = 0; i < injectCandidates.length; ++i) {
            match = injectCandidates[i].exec(contents)
            if (match) {
              injectTag = match[0]
              break
            }
          }
          // 容量控制（近似 FIFO）：先 delete 同 key —— mtime 变化是「更新已有条目」，delete 后再 set
          // 会把它移到插入序末尾，避免它留在队首附近、在容量满时把无关的旧条目误淘汰。
          // 命中路径不刷新顺序，所以只近似 FIFO / 不是严格 LRU；对本场景够用且实现最简。
          // 缓存值含 null，表示该文件确认无注入标签（避免反复读文件确认）。
          injectCache.delete(filepath)
          if (injectCache.size >= INJECT_CACHE_LIMIT) {
            var oldestKey = injectCache.keys().next().value
            injectCache.delete(oldestKey)
          }
          injectCache.set(filepath, { mtimeMs: mtimeMs, tag: injectTag })
        }

        if (!injectTag && onTagMissedCallback) {
          onTagMissedCallback()
        }

        if (injectTag === null && LiveServer.logLevel >= 3) {
          console.warn(
            'Failed to inject refresh script!',
            "Couldn't find any of the tags ",
            injectCandidates,
            'from',
            filepath
          )
        }
      }
    }

    function error(err) {
      if (err.status === 404) return next()
      next(err)
    }

    function inject(stream) {
      if (injectTag) {
        // We need to modify the length given to browser
        // 用字节长度而不是字符串 length：注入脚本若包含非 ASCII 字符，两者会不一致，
        // 导致 Content-Length 与实际响应体不匹配（客户端报 parse error）。
        var injectedCode = GET_INJECTED_CODE()
        var len = Buffer.byteLength(injectedCode) + Number(res.getHeader('Content-Length'))
        res.setHeader('Content-Length', len)
        var originalPipe = stream.pipe
        stream.pipe = function (resp) {
          originalPipe.call(stream, replaceFirstTagStream(injectTag, injectedCode + injectTag)).pipe(resp)
        }
      }
    }

    send(req, reqpath, {
      root: root,
    })
      .on('error', error)
      .on('directory', directory)
      .on('file', file)
      .on('stream', inject)
      .pipe(res)
  }
}

/**
 * Rewrite request URL and pass it back to the static handler.
 * @param staticHandler {function} Next handler
 * @param file {string} Path to the entry point file
 */
function entryPoint(staticHandler, file) {
  if (!file)
    return function (req, res, next) {
      next()
    }

  return function (req, res, next) {
    req.url = '/' + file
    staticHandler(req, res, next)
  }
}

/**
 * Start a live server with parameters given as an object
 * @param host {string} Address to bind to (default: 0.0.0.0)
 * @param port {number} Port number (default: 8080)
 * @param root {string} Path to root directory (default: cwd)
 * @param watch {array} Paths to exclusively watch for changes
 * @param ignore {array} Paths to ignore when watching files for changes
 * @param ignorePattern {regexp} Ignore files by RegExp
 * @param open {(string|string[])} Subpath(s) to open in browser, use false to suppress launch (default: server root)
 * @param mount {array} Mount directories onto a route, e.g. [['/components', './node_modules']].
 * @param logLevel {number} 0 = errors only, 1 = some, 2 = lots
 * @param file {string} Path to the entry point file
 * @param wait {number} Server will wait for all changes, before reloading
 * @param htpasswd {string} Path to htpasswd file to enable HTTP Basic authentication
 * @param middleware {array} Append middleware to stack, e.g. [function(req, res, next) { next(); }].
 */
LiveServer.start = function (options, callback) {
  options = options || {}
  var host = options.host || '0.0.0.0'
  var port = options.port !== undefined ? options.port : 8080 // 0 means random
  var root = options.root || process.cwd()
  var mount = options.mount || []
  var watchPaths = options.watch || [root]
  LiveServer.logLevel = options.logLevel === undefined ? 2 : options.logLevel
  var openPath =
    options.open === undefined || options.open === true
      ? ''
      : options.open === null || options.open === false
      ? null
      : options.open
  if (options.noBrowser) openPath = null // Backwards compatibility with 0.7.0
  var file = options.file
  var wait = options.wait === undefined ? 100 : options.wait
  var browser = options.browser || null
  var htpasswd = options.htpasswd || null
  var cors = options.cors || false
  var https = options.https || null
  var proxy = options.proxy || []
  var middleware = options.middleware || []
  /*new*/
  useBrowserExtension = options.useBrowserExtension || false //global scope
  // var addtionalHTMLtags = options.addtionalHTMLtags || []; //dropped the feature
  var disableGlobbing = options.disableGlobbing || false
  var onTagMissedCallback = options.onTagMissedCallback || null
  var fullReload = options.fullReload || false

  var staticServerHandler = staticServer(root, onTagMissedCallback)

  // Setup a web server
  var app = connect()

  // Add logger. Level 2 logs only errors
  if (LiveServer.logLevel === 2) {
    app.use(
      logger('dev', {
        skip: function (req, res) {
          return res.statusCode < 400
        },
      })
    )
    // Level 2 or above logs all requests
  } else if (LiveServer.logLevel > 2) {
    app.use(logger('dev'))
  }
  if (options.spa) {
    middleware.push('spa')
  }
  // Add middleware
  middleware.map(function (mw) {
    if (typeof mw === 'string') {
      var ext = path.extname(mw).toLocaleLowerCase()
      if (ext !== '.js') {
        mw = require(path.join(__dirname, 'middleware', mw + '.js'))
      } else {
        mw = require(mw)
      }
    }
    app.use(mw)
  })

  // Use http-auth if configured（可选能力：包已裁剪，缺失时抛出说明性错误）
  if (htpasswd !== null) {
    var auth = optionalRequire('http-auth', 'HTTP Basic 认证（htpasswd）')
    var basic = auth.basic({
      realm: 'Please authorize',
      file: htpasswd,
    })
    app.use(auth.connect(basic))
  }
  if (cors) {
    app.use(
      optionalRequire('cors', 'CORS')({
        origin: true, // reflecting request origin
        credentials: true, // allowing requests with credentials
      })
    )
  }
  mount.forEach(function (mountRule) {
    var mountPath = path.resolve(process.cwd(), mountRule[1])
    if (!options.watch)
      // Auto add mount paths to wathing but only if exclusive path option is not given
      watchPaths.push(mountPath)
    app.use(mountRule[0], staticServer(mountPath, staticServer, onTagMissedCallback))
    if (LiveServer.logLevel >= 1) console.log('Mapping %s to "%s"', mountRule[0], mountPath)
  })
  proxy.forEach(function (proxyRule) {
    var proxyOpts = url.parse(proxyRule[1])
    proxyOpts.via = true
    proxyOpts.preserveHost = true
    // 可选能力：proxy-middleware 已裁剪，传了 proxy 参数才会走到这里并抛出说明性错误
    app.use(proxyRule[0], optionalRequire('proxy-middleware', 'proxy 代理')(proxyOpts))
    if (LiveServer.logLevel >= 1) console.log('Mapping %s to "%s"', proxyRule[0], proxyRule[1])
  })
  app
    .use(staticServerHandler) // Custom static server
    .use(entryPoint(staticServerHandler, file))
    .use(
      serveIndex(root, {
        icons: true,
      })
    )

  var server, protocol
  if (https !== null) {
    var httpsConfig = https
    if (typeof https === 'string') {
      httpsConfig = require(path.resolve(process.cwd(), https))
    }
    server = require('https').createServer(httpsConfig, app)
    protocol = 'https'
  } else {
    server = http.createServer(app)
    protocol = 'http'
  }

  // Handle server startup errors
  // 回归说明：旧实现里 console.error(e.toString().red) 依赖 colors（本仓库未 require，恒为 undefined，
  // 等于把真实错误吞成 "undefined"），随后调用模块级 LiveServer.shutdown() —— 它关的是「最近一次监听
  // 成功的另一个 server/watcher」，于是一次端口冲突会静默误杀别的服务。这里改为只清理本次启动的实例。
  server.addListener('error', function (e) {
    console.error(e)
    // watcher 在本函数末尾同步创建（listen 错误是异步事件，创建一定已执行），存在则一并关闭
    if (server.watcher) {
      var closingWatcher = server.watcher.close()
      // chokidar 的 close() 返回 Promise；错误路径上没人 await，兜住避免 unhandledRejection
      if (closingWatcher && typeof closingWatcher.catch === 'function') closingWatcher.catch(function () {})
    }
    // 只关闭自己：未进入 listening 时 close() 本身是空操作，这里保留判断让意图更明确
    if (server.listening) {
      server.close()
    }
  })

  // Handle successful server
  server.addListener('listening', function (/*e*/) {
    LiveServer.server = server

    var address = server.address()
    var serveHost = address.address === '0.0.0.0' ? '127.0.0.1' : address.address
    var openHost = host === '0.0.0.0' ? '127.0.0.1' : host

    var serveURL = protocol + '://' + serveHost + ':' + address.port
    var openURL = protocol + '://' + openHost + ':' + address.port

    var serveURLs = [serveURL]
    if (LiveServer.logLevel > 2 && address.address === '0.0.0.0') {
      var ifaces = os.networkInterfaces()
      serveURLs = Object.keys(ifaces)
        .map(function (iface) {
          return ifaces[iface]
        })
        // flatten address data, use only IPv4
        .reduce(function (data, addresses) {
          addresses
            .filter(function (addr) {
              return addr.family === 'IPv4'
            })
            .forEach(function (addr) {
              data.push(addr)
            })
          return data
        }, [])
        .map(function (addr) {
          return protocol + '://' + addr.address + ':' + address.port
        })
    }

    // Output
    if (LiveServer.logLevel >= 1) {
      if (serveURL === openURL)
        if (serveURLs.length === 1) {
          console.log('Serving "%s" at %s', root, serveURLs[0])
        } else {
          console.log('Serving "%s" at\n\t%s', root, serveURLs.join('\n\t'))
        }
      else console.log('Serving "%s" at %s (%s)', root, openURL, serveURL)
    }

    // Launch browser
    // opn 是可选依赖：仅在显式传了 open（openPath !== null）时才 require，避免默认路径加载它
    // （本插件后续会改为渲染层在 ready 后用 utools.shellOpenExternal 打开，lib 侧不会再走到这里）。
    // require 包一层 try/catch：T3 依赖裁剪可能从 package.json 移除 opn，缺失时只告警、不影响服务启动。
    if (openPath !== null) {
      var open = null
      try {
        open = require('opn')
      } catch (e) {
        if (LiveServer.logLevel >= 1) console.warn('opn 不可用，跳过自动打开浏览器:', e && e.message)
      }
      if (open)
        if (typeof openPath === 'object') {
          openPath.forEach(function (p) {
            open(openURL + p, {
              app: browser,
            })
          })
        } else {
          open(openURL + openPath, {
            app: browser,
          })
        }
    }
  })

  // Setup server to listen at port
  server.listen(port, host)

  // WebSocket
  var clients = []
  server.addListener('upgrade', function (request, socket, head) {
    if (!request.url.endsWith('/ws')) {
      // 非热刷新通道：只有配置了 proxy 才转发。proxy 默认 []，旧写法 url.parse(proxy[0][1]) 会直接抛
      // TypeError（该监听器无兜底，站点自带 WebSocket 时可能崩掉整个 preload）。http-proxy 是可选
      // 依赖，同样懒加载，避免无 proxy 配置时加载。
      if (proxy.length) {
        // 可选能力：http-proxy 已裁剪，只有配置了 proxy（含 WebSocket 转发）才会走到这里
        var httpProxy = optionalRequire('http-proxy', 'proxy 的 WebSocket 转发')
        var proxyURL = url.parse(proxy[0][1])
        new httpProxy.createProxyServer({
          target: {
            host: proxyURL.host,
          },
          secure: false,
        }).ws(request, socket, head)
        return
      }
      // 既不是热刷新也不是代理目标：主动断开，避免请求悬挂占着连接
      socket.destroy()
      return
    }
    var ws = new WebSocket(request, socket, head)
    ws.onopen = function () {
      ws.send('connected')
    }

    if (wait > 0) {
      ;(function () {
        var wssend = ws.send
        var waitTimeout
        ws.send = function () {
          var args = arguments
          if (waitTimeout) clearTimeout(waitTimeout)
          waitTimeout = setTimeout(function () {
            wssend.apply(ws, args)
          }, wait)
        }
      })()
    }

    ws.onclose = function () {
      clients = clients.filter(function (x) {
        return x !== ws
      })
    }

    clients.push(ws)
  })

  var ignored = [
    function (testPath) {
      // Always ignore dotfiles (important e.g. because editor hidden temp files)
      return testPath !== '.' && /(^[.#]|(?:__|~)$)/.test(path.basename(testPath))
    },
    '**/node_modules/**',
  ]
  if (options.ignore) {
    ignored = ignored.concat(options.ignore)
  }
  if (options.ignorePattern) {
    ignored.push(options.ignorePattern)
  }
  // Setup file watcher
  // 同一个 watcher 同时保存在模块级（兼容旧 API LiveServer.shutdown）与本次 server 实例上：
  // 停止时由 preload 调 server.watcher.close() 精确关闭。旧实现只存模块级全局，stop 不关闭、
  // 下一次 start 直接覆盖引用 → 旧 watcher 永久失联并持续监听（句柄/CPU 累积、reload 重复广播）。
  LiveServer.watcher = chokidar.watch(watchPaths, {
    ignored: ignored,
    ignoreInitial: true,
    disableGlobbing: disableGlobbing,
  })
  server.watcher = LiveServer.watcher

  function handleChange(changePath) {
    var cssChange = path.extname(changePath) === '.css'
    if (LiveServer.logLevel >= 1) {
      if (cssChange) console.log('CSS change detected', changePath)
      else console.log('Change detected', changePath)
    }
    clients.forEach(function (ws) {
      if (ws) ws.send(cssChange && !fullReload ? 'refreshcss' : 'reload')
    })
  }

  //return server;

  LiveServer.watcher
    .on('change', handleChange)
    .on('add', handleChange)
    .on('unlink', handleChange)
    .on('addDir', handleChange)
    .on('unlinkDir', handleChange)
    .on('ready', function () {
      if (LiveServer.logLevel >= 1) console.log('Ready for changes')
      if (callback) {
        callback()
      }
    })
    .on('error', function (err) {
      console.log('ERROR:', err)
    })

  return server
}

LiveServer.shutdown = function () {
  var watcher = LiveServer.watcher
  if (watcher) {
    watcher.close()
  }
  var server = LiveServer.server
  if (server) server.close()
}

module.exports = LiveServer
