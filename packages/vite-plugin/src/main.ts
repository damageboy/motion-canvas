import type {Plugin, ResolvedConfig} from 'vite';
import path from 'path';
import fs from 'fs';
import {Readable} from 'stream';

export interface MotionCanvasPluginConfig {
  /**
   * The import path of the project file.
   *
   * @remarks
   * The file must contain a default export exposing an instance of the
   * {@link Project} class.
   *
   * @default './src/project.ts'
   */
  project?: string;
  /**
   * Defines which assets should be buffered before being sent to the browser.
   *
   * @remarks
   * Streaming larger assets directly from the drive my cause issues with other
   * applications. For instance, if an audio file is being used in the project,
   * Adobe Audition will perceive it as "being used by another application"
   * and refuse to override it.
   *
   * Buffered assets are first loaded to the memory and then streamed from
   * there. This leaves the original files open for modification with hot module
   * replacement still working.
   *
   * @default /\.(wav|mp3|ogg)$/
   */
  bufferedAssets?: RegExp;
  editor?: {
    /**
     * The import path of the editor factory file.
     *
     * @remarks
     * The file must contain a default export exposing a factory function.
     * This function will be called with the project as its first argument.
     * Its task is to create the user interface.
     *
     * @default '\@motion-canvas/ui'
     */
    factory?: string;
    /**
     * The import path of the editor styles.
     *
     * @default '\@motion-canvas/ui/dist/style.css'
     */
    styles?: string;
  };
}

export default ({
  project = './src/project.ts',
  bufferedAssets = /\.(wav|mp3|ogg)$/,
  editor: {
    styles = '@motion-canvas/ui/dist/style.css',
    factory = '@motion-canvas/ui',
  } = {},
}: MotionCanvasPluginConfig = {}): Plugin => {
  const editorPath = path.dirname(require.resolve('@motion-canvas/ui'));
  const editorId = 'virtual:editor';
  const resolvedEditorId = '\0' + editorId;
  const timeStamps: Record<string, number> = {};
  const projectName = path.parse(project).name;

  let viteConfig: ResolvedConfig;

  function source(...lines: string[]) {
    return lines.join('\n');
  }

  async function createMeta(metaPath: string) {
    if (!fs.existsSync(metaPath)) {
      await fs.promises.writeFile(
        metaPath,
        JSON.stringify({version: 0}, undefined, 2),
        'utf8',
      );
    }
  }

  return {
    name: 'motion-canvas',
    async configResolved(resolvedConfig) {
      viteConfig = resolvedConfig;
    },
    resolveId(id) {
      if (id === editorId) {
        return resolvedEditorId;
      }
    },
    load(id) {
      if (id === resolvedEditorId) {
        return source(
          `import '${styles}';`,
          `import editor from '${factory}';`,
          `import project from '${project}';`,
          `editor(project);`,
        );
      }
    },
    async transform(code, id) {
      const [base, query] = id.split('?');
      const {name, dir, ext} = path.posix.parse(base);

      if (query) {
        const params = new URLSearchParams(query);
        if (params.has('img')) {
          return source(
            `import {loadImage} from '@motion-canvas/core/lib/media';`,
            `import image from '/@fs/${base}';`,
            `export default loadImage(image);`,
          );
        }

        if (params.has('anim')) {
          const nameRegex = /\D*(\d+)\./;
          let urls: string[] = [];
          for (const file of await fs.promises.readdir(dir)) {
            const match = nameRegex.exec(file);
            if (!match) continue;
            const index = parseInt(match[1]);
            urls[index] = path.posix.join(dir, file);
          }
          urls = urls.filter(Boolean);

          return source(
            `import {loadAnimation} from '@motion-canvas/core/lib/media';`,
            ...urls.map(
              (url, index) => `import image${index} from '/@fs/${url}';`,
            ),
            `export default loadAnimation([${urls
              .map((_, index) => `image${index}`)
              .join(', ')}]);`,
          );
        }
      }

      if (ext === '.meta') {
        return source(
          `import {Meta} from '@motion-canvas/core/lib';`,
          `Meta.register(`,
          `  '${name}',`,
          `  ${viteConfig.command === 'build' ? false : `'${id}'`},`,
          `  \`${code}\``,
          `);`,
          `if (import.meta.hot) {`,
          `  import.meta.hot.accept();`,
          `}`,
        );
      }

      if (name === projectName && (await this.resolve(project))?.id === id) {
        const metaFile = `${name}.meta`;
        await createMeta(path.join(dir, metaFile));

        const imports =
          `import '@motion-canvas/core/lib/patches/Factory';` +
          `import '@motion-canvas/core/lib/patches/Node';` +
          `import '@motion-canvas/core/lib/patches/Shape';` +
          `import '@motion-canvas/core/lib/patches/Container';` +
          `import './${metaFile}';`;

        return imports + code;
      }

      if (name.endsWith('.scene')) {
        const metaFile = `${name}.meta`;
        await createMeta(path.join(dir, metaFile));

        const imports =
          `import './${metaFile}';` +
          `import {useProject as __useProject} from '@motion-canvas/core/lib/utils';`;
        const hmr = source(
          `if (import.meta.hot) {`,
          `  import.meta.hot.accept(module => {`,
          `    __useProject()?.updateScene(module.default);`,
          `  });`,
          `}`,
        );
        return imports + code + '\n' + hmr;
      }
    },
    handleHotUpdate(ctx) {
      const now = Date.now();
      const urls = [];
      const modules = [];

      for (const module of ctx.modules) {
        if (
          module.file !== null &&
          timeStamps[module.file] &&
          timeStamps[module.file] + 1000 > now
        ) {
          continue;
        }

        urls.push(module.url);
        modules.push(module);
      }

      if (urls.length > 0) {
        ctx.server.ws.send('motion-canvas:assets', {urls});
      }

      return modules;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && bufferedAssets.test(req.url)) {
          const file = fs.readFileSync(
            path.resolve(viteConfig.root, req.url.slice(1)),
          );
          const stream = Readable.from(file);
          stream.on('end', console.log).pipe(res);
          return;
        }

        if (req.url === '/') {
          const stream = fs.createReadStream(
            path.resolve(editorPath, '../editor.html'),
          );
          stream.pipe(res);
          return;
        }

        next();
      });
      server.ws.on('motion-canvas:meta', async ({source, data}, client) => {
        timeStamps[source] = Date.now();
        await fs.promises.writeFile(
          source,
          JSON.stringify(data, undefined, 2),
          'utf8',
        );
        client.send('motion-canvas:meta-ack', {source});
      });
    },
    config() {
      return {
        esbuild: {
          jsx: 'automatic',
          jsxImportSource: '@motion-canvas/core/lib',
        },
        define: {
          PROJECT_FILE_NAME: `'${projectName}'`,
        },
        build: {
          lib: {
            entry: project,
            formats: ['es'],
          },
        },
      };
    },
  };
};