// Win-Term-Mac / Src_Rust —— 角色【文本渲染】。
//
// 职责:拿到 `term::GridSnapshot`(整屏只读网格快照),用 glyphon + cosmic-text
// 在已有的 wgpu 窗口里把终端网格按等宽字体逐行绘制出来。
//
// 本文件只做“文本上屏”:不创建窗口、不持有 surface、不做清屏(清屏由 main.rs 负责)。
// main.rs 每帧先清屏,再调用 `Renderer::render(...)` 把文字叠加上去,最后 present。
//
// ---------------------------------------------------------------------------
// 给 lead 的集成说明(在 main.rs 里怎么用):
//
//   // 1) mod 声明
//   mod render;
//   use render::Renderer;
//
//   // 2) 在 GpuState::new(...) 末尾,device/queue/format/尺寸都就绪后创建:
//   let renderer = Renderer::new(
//       &device,
//       &queue,
//       config.format,          // wgpu::TextureFormat(surface 格式)
//       config.width,
//       config.height,
//       window.scale_factor() as f32,
//   );
//   // 把 renderer 存进 GpuState(新增一个字段 `renderer: Renderer`)。
//
//   // 3) 窗口尺寸变化时(GpuState::resize 里):
//   self.renderer.resize(width, height);
//
//   // 4) 渲染一帧(GpuState::render 里,清屏 pass 之后、frame.present() 之前):
//   let snapshot = terminal.snapshot();          // 来自 term::Terminal
//   self.renderer.render(&snapshot, &self.device, &self.queue, &view);
//
//   // 5)(可选)由像素尺寸反推终端应有的行列数,喂给 Terminal::resize:
//   let (cols, rows) = self.renderer.grid_size_for(config.width, config.height);
//   terminal.resize(cols, rows);
// ---------------------------------------------------------------------------

use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, Style,
    SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};

use crate::term::{GridCell, GridSnapshot, Rgb};

/// 逻辑像素下的基础字号(实际渲染时会乘 scale_factor 变成物理像素)。
const BASE_FONT_SIZE: f32 = 15.0;
/// 行高相对字号的倍数(终端一般略大于 1.0,给字形留呼吸空间)。
const LINE_HEIGHT_FACTOR: f32 = 1.25;
/// 网格四周留白(逻辑像素)。
const PADDING: f32 = 4.0;

/// GPU 文本渲染器。持有 glyphon 的全部长生命周期资源;每帧消费一个 `GridSnapshot`。
///
/// 注意:本结构体不持有 wgpu 的 device/queue/surface —— 那些由 main.rs 的 GpuState
/// 持有,并在 `new` / `render` 调用时以引用传入。
pub struct Renderer {
    font_system: FontSystem,
    swash_cache: SwashCache,
    viewport: Viewport,
    atlas: TextAtlas,
    text_renderer: TextRenderer,

    /// 物理像素字号 = BASE_FONT_SIZE * scale_factor。
    font_size: f32,
    /// 物理像素行高。
    line_height: f32,
    /// 单个等宽单元格的物理像素宽度(由字体实际步进测得)。
    cell_width: f32,
    /// 物理像素留白。
    padding: f32,
    /// HiDPI 缩放。
    scale_factor: f32,

    /// 当前 surface 的物理像素尺寸(供 Viewport 使用)。
    width: u32,
    height: u32,
}

impl Renderer {
    /// 创建文本渲染器。
    ///
    /// 参数:
    /// - `device` / `queue`:main.rs 里 wgpu 的设备与队列(仅在此借用,不被持有)。
    /// - `surface_format`:surface 的像素格式(即 main.rs 的 `config.format`);
    ///   glyphon 的渲染管线必须与最终写入的 TextureView 格式一致。
    /// - `width` / `height`:surface 的物理像素尺寸(`config.width` / `config.height`)。
    /// - `scale_factor`:窗口 DPI 缩放(`window.scale_factor()`)。字号与坐标按此放大到物理像素。
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface_format: wgpu::TextureFormat,
        width: u32,
        height: u32,
        scale_factor: f32,
    ) -> Self {
        let scale_factor = if scale_factor > 0.0 { scale_factor } else { 1.0 };

        let mut font_system = FontSystem::new();
        let swash_cache = SwashCache::new();

        // glyphon 0.6:Cache 是共享的着色器/管线缓存,Viewport 持有屏幕分辨率 uniform。
        let cache = Cache::new(device);
        let viewport = Viewport::new(device, &cache);
        let mut atlas = TextAtlas::new(device, queue, &cache, surface_format);
        let text_renderer =
            TextRenderer::new(&mut atlas, device, wgpu::MultisampleState::default(), None);

        let font_size = BASE_FONT_SIZE * scale_factor;
        let line_height = font_size * LINE_HEIGHT_FACTOR;

        // 用实际字体步进测量等宽单元格宽度(比经验系数更贴合所选 Monospace 字体)。
        let cell_width = measure_cell_width(&mut font_system, font_size, line_height);

        Self {
            font_system,
            swash_cache,
            viewport,
            atlas,
            text_renderer,
            font_size,
            line_height,
            cell_width,
            padding: PADDING * scale_factor,
            scale_factor,
            width: width.max(1),
            height: height.max(1),
        }
    }

    /// surface 尺寸变化时更新记录的物理像素尺寸(Viewport 会在下一帧 render 时刷新)。
    pub fn resize(&mut self, width: u32, height: u32) {
        self.width = width.max(1);
        self.height = height.max(1);
    }

    /// 单元格的(宽, 高)物理像素尺寸。lead 可用它做命中测试或布局。
    pub fn cell_size(&self) -> (f32, f32) {
        (self.cell_width, self.line_height)
    }

    /// 根据物理像素尺寸反推可容纳的(列, 行)数,便于 lead 调 `Terminal::resize`。
    /// 已扣除四周留白;至少返回 1x1。
    pub fn grid_size_for(&self, width_px: u32, height_px: u32) -> (usize, usize) {
        let avail_w = (width_px as f32 - 2.0 * self.padding).max(0.0);
        let avail_h = (height_px as f32 - 2.0 * self.padding).max(0.0);
        let cols = (avail_w / self.cell_width).floor() as usize;
        let rows = (avail_h / self.line_height).floor() as usize;
        (cols.max(1), rows.max(1))
    }

    /// 把一屏终端网格绘制到 `view` 上。
    ///
    /// 参数:
    /// - `snapshot`:来自 `Terminal::snapshot()` 的整屏网格快照。
    /// - `device` / `queue`:wgpu 设备与队列(用于上传字形与提交绘制)。
    /// - `view`:本帧目标纹理视图(通常是 surface 当前帧的 TextureView)。
    ///
    /// 语义:本方法用 `LoadOp::Load` 在已有内容之上叠加文字,并自行提交一个
    /// command buffer。因此调用前 main.rs 应已完成清屏,调用后再 `frame.present()`。
    /// 失败(如字形图集写满)时不 panic,仅记录日志并跳过本帧文字。
    pub fn render(
        &mut self,
        snapshot: &GridSnapshot,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        view: &wgpu::TextureView,
    ) {
        // 1) 刷新屏幕分辨率(glyphon 用它把像素坐标换算到裁剪空间)。
        self.viewport.update(
            queue,
            Resolution {
                width: self.width,
                height: self.height,
            },
        );

        // 2) 把网格转成一个整屏富文本 Buffer(每行一个逻辑行,行间以 '\n' 分隔)。
        //    per-cell 前景色/粗体/斜体通过 rich-text 分段(span)表达。
        let (text, runs) = build_grid_text(snapshot);

        let mut grid_buffer = Buffer::new(
            &mut self.font_system,
            Metrics::new(self.font_size, self.line_height),
        );
        // 不自动换行:宽度传 None 关闭软换行,让每个逻辑行按原样铺开
        //(终端自身已按列折行;可见范围由 TextArea.bounds 裁剪)。
        grid_buffer.set_size(&mut self.font_system, None, None);
        {
            // span 迭代器借用 `text`,故必须在同一作用域内立即消费。
            let default_attrs = Attrs::new()
                .family(Family::Monospace)
                .color(to_color(super_default_fg()));
            let spans = runs
                .iter()
                .map(|r| (&text[r.start..r.end], r.attrs.clone()));
            grid_buffer.set_rich_text(
                &mut self.font_system,
                spans,
                default_attrs,
                Shaping::Advanced,
            );
        }
        grid_buffer.shape_until_scroll(&mut self.font_system, false);

        // 3) 光标:用一个独立的小 Buffer 画“下划线块”(▁)在光标所在格。
        //    简化实现:不做反显,不遮挡字符。TODO(cursor):后续可换成实心块 '█'
        //    + 该格字符用背景色反显,更贴近真实终端光标。
        let cursor = &snapshot.cursor;
        let draw_cursor = cursor.visible
            && cursor.row < snapshot.rows
            && cursor.col < snapshot.cols;
        let mut cursor_buffer = Buffer::new(
            &mut self.font_system,
            Metrics::new(self.font_size, self.line_height),
        );
        if draw_cursor {
            cursor_buffer.set_size(
                &mut self.font_system,
                Some(self.cell_width * 2.0),
                Some(self.line_height),
            );
            // 光标颜色:取该格前景色,保证在任意背景上可见。
            let under = snapshot
                .cell(cursor.row, cursor.col)
                .map(|c| effective_fg(c))
                .unwrap_or_else(super_default_fg);
            cursor_buffer.set_text(
                &mut self.font_system,
                "\u{2581}", // ▁ LOWER ONE EIGHTH BLOCK,作下划线光标
                Attrs::new().family(Family::Monospace).color(to_color(under)),
                Shaping::Advanced,
            );
            cursor_buffer.shape_until_scroll(&mut self.font_system, false);
        }

        // 4) 组装 TextArea 列表。网格铺在留白起点;光标定位到具体单元格。
        let full_bounds = TextBounds {
            left: 0,
            top: 0,
            right: self.width as i32,
            bottom: self.height as i32,
        };

        let mut areas: Vec<TextArea> = Vec::with_capacity(2);
        areas.push(TextArea {
            buffer: &grid_buffer,
            left: self.padding,
            top: self.padding,
            scale: 1.0,
            bounds: full_bounds,
            default_color: to_color(super_default_fg()),
            custom_glyphs: &[],
        });
        if draw_cursor {
            let cx = self.padding + cursor.col as f32 * self.cell_width;
            let cy = self.padding + cursor.row as f32 * self.line_height;
            areas.push(TextArea {
                buffer: &cursor_buffer,
                left: cx,
                top: cy,
                scale: 1.0,
                bounds: full_bounds,
                default_color: to_color(super_default_fg()),
                custom_glyphs: &[],
            });
        }

        // 5) 准备(上传字形到图集,生成顶点)。写满图集等错误不致命,跳过本帧文字。
        if let Err(e) = self.text_renderer.prepare(
            device,
            queue,
            &mut self.font_system,
            &mut self.atlas,
            &self.viewport,
            areas,
            &mut self.swash_cache,
        ) {
            log::warn!("glyphon prepare 失败,跳过本帧文字: {e:?}");
            return;
        }

        // 6) 在目标视图上开一个 Load 语义的 render pass 绘制文字,并提交。
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("text-encoder"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("text-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // Load:保留 main.rs 清屏后的背景,把文字叠加上去。
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if let Err(e) =
                self.text_renderer.render(&self.atlas, &self.viewport, &mut pass)
            {
                log::warn!("glyphon render 失败: {e:?}");
            }
        }
        queue.submit(std::iter::once(encoder.finish()));

        // 7) 回收本帧未再使用的图集空间(glyphon 推荐每帧调用)。
        self.atlas.trim();

        // scale_factor 目前在 new() 一次性折进字号/坐标;若 lead 需要运行时 DPI 变更,
        // 可后续加 set_scale_factor 重新计算 font_size/line_height/cell_width。
        let _ = self.scale_factor;
    }
}

// ===========================================================================
// 内部辅助
// ===========================================================================

/// 一个富文本分段:`text[start..end]` 这段用 `attrs` 的样式(同前景色/粗斜体)。
struct StyleRun {
    start: usize,
    end: usize,
    attrs: Attrs<'static>,
}

/// 把整屏网格拼成一个字符串 + 若干样式分段。
///
/// - 行主序,每行末尾(除最后一行)追加 '\n' 作为逻辑换行。
/// - 连续的同色/同粗斜体单元格合并成一个 span,减少分段数量。
/// - 空单元格保留为空格,以维持等宽网格的列对齐。
fn build_grid_text(snapshot: &GridSnapshot) -> (String, Vec<StyleRun>) {
    let rows = snapshot.rows;
    let cols = snapshot.cols;

    let mut text = String::with_capacity(rows * (cols + 1));
    let mut runs: Vec<StyleRun> = Vec::new();

    for row in 0..rows {
        // 当前 span 的样式键与起始字节位置。
        let mut cur_key: Option<(Rgb, bool, bool)> = None;
        let mut run_start = text.len();

        for col in 0..cols {
            let cell = snapshot.cell(row, col).copied().unwrap_or_default();
            let fg = effective_fg(&cell);
            let key = (fg, cell.bold, cell.italic);

            // 控制字符/空字符统一渲染为空格,避免出现豆腐块或吞掉列。
            let ch = match cell.c {
                '\0' => ' ',
                c if (c as u32) < 0x20 => ' ',
                c => c,
            };

            if cur_key != Some(key) {
                // 收尾上一段。
                if let Some((rgb, bold, italic)) = cur_key {
                    if run_start < text.len() {
                        runs.push(StyleRun {
                            start: run_start,
                            end: text.len(),
                            attrs: attrs_for(rgb, bold, italic),
                        });
                    }
                }
                cur_key = Some(key);
                run_start = text.len();
            }
            text.push(ch);
        }

        // 收尾本行最后一段。
        if let Some((rgb, bold, italic)) = cur_key {
            if run_start < text.len() {
                runs.push(StyleRun {
                    start: run_start,
                    end: text.len(),
                    attrs: attrs_for(rgb, bold, italic),
                });
            }
        }

        if row + 1 < rows {
            text.push('\n'); // 逻辑换行,不归入任何 span(用默认样式即可)。
        }
    }

    (text, runs)
}

/// 由 RGB + 粗斜体构造 glyphon Attrs(等宽字体族)。
fn attrs_for(fg: Rgb, bold: bool, italic: bool) -> Attrs<'static> {
    let mut a = Attrs::new().family(Family::Monospace).color(to_color(fg));
    if bold {
        a = a.weight(Weight::BOLD);
    }
    if italic {
        a = a.style(Style::Italic);
    }
    a
}

/// 计算单元格“有效前景色”:inverse 时前景背景互换(用背景色画字)。
///
/// 说明:本渲染器目前只画字形、不画单元格背景块,所以 inverse 通过换用背景色作字色
/// 来近似。TODO(bg):要完整还原 inverse/选中高亮,需要额外画单元格背景矩形。
fn effective_fg(cell: &GridCell) -> Rgb {
    if cell.inverse {
        cell.bg
    } else {
        cell.fg
    }
}

/// 兜底默认前景色(与 term.rs 的深色主题 DEFAULT_FG 保持一致)。
/// term.rs 未把该常量设为 pub,这里就近再定义一份;若日后导出可改为引用。
fn super_default_fg() -> Rgb {
    Rgb {
        r: 0xd0,
        g: 0xd6,
        b: 0xdf,
    }
}

/// term::Rgb -> glyphon::Color(不透明)。
#[inline]
fn to_color(rgb: Rgb) -> Color {
    Color::rgb(rgb.r, rgb.g, rgb.b)
}

/// 用实际字体步进测量一个等宽单元格的物理像素宽度。
///
/// 排版一串等宽字符,用整行宽度除以字符数得到单格步进,比经验系数更贴合字体。
/// 失败(拿不到布局)时回退到 font_size * 0.6 的经验值。
fn measure_cell_width(font_system: &mut FontSystem, font_size: f32, line_height: f32) -> f32 {
    const SAMPLE: &str = "MMMMMMMMMMMMMMMM"; // 16 个 M
    const N: f32 = 16.0;

    let mut buf = Buffer::new(font_system, Metrics::new(font_size, line_height));
    buf.set_size(font_system, Some(f32::MAX), Some(line_height));
    buf.set_text(
        font_system,
        SAMPLE,
        Attrs::new().family(Family::Monospace),
        Shaping::Advanced,
    );
    buf.shape_until_scroll(font_system, false);

    for run in buf.layout_runs() {
        if run.line_w > 0.0 {
            return run.line_w / N;
        }
    }
    font_size * 0.6
}
