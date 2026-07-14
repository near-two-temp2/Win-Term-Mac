// Win-Term-Mac / Src_Rust —— 纯 Rust 自绘方案入口。
//
// 本文件负责【Scaffold】:打开一个 winit 窗口并初始化 wgpu(最小可运行),
// 具体的窗格树、终端仿真、命令面板、键位由各自模块实现。

// 各角色模块声明。对应文件由各自负责人创建:
mod pane; // 窗格二叉树:split / swap / move / navigate / walk / maximize
mod term; // 终端仿真 + PTY(alacritty_terminal + portable-pty)
mod palette; // 命令面板:低频强力操作(交换/移动窗格)入口
mod keymap; // 键位映射:热键与命令面板触发
mod render; // 文本渲染(glyphon + cosmic-text):把终端网格画到 wgpu 表面
mod input; // 键盘事件 → 写入 PTY 的字节序列

use std::sync::Arc;

use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId};

/// wgpu 渲染上下文。持有 surface / device / queue 等 GPU 资源。
struct GpuState {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    window: Arc<Window>,
    /// 文本渲染器(glyphon):消费 term 的网格快照逐格绘制。
    renderer: render::Renderer,
    /// 当前聚焦的终端叶子(暂为单终端;接入窗格树后改为按 pane 管理)。
    terminal: term::Terminal,
    /// 当前修饰键状态,供键盘输入翻译。
    modifiers: winit::keyboard::ModifiersState,
}

impl GpuState {
    /// 基于给定窗口创建 wgpu 上下文。异步,由调用方用 pollster 阻塞。
    async fn new(window: Arc<Window>) -> Self {
        let size = window.inner_size();
        // 尺寸兜底,避免某些平台首帧为 0 导致 surface 配置失败。
        let width = size.width.max(1);
        let height = size.height.max(1);

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            ..Default::default()
        });

        let surface = instance
            .create_surface(window.clone())
            .expect("创建 wgpu surface 失败");

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .expect("找不到可用的 GPU 适配器");

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("win-term-mac-device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_defaults(),
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await
            .expect("创建 wgpu device 失败");

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(caps.formats[0]);

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        // 文本渲染器 + 终端叶子:先建渲染器(拿到单元格尺寸),
        // 再据窗口像素反推初始网格行列,启动子 shell。
        let scale_factor = window.scale_factor() as f32;
        let renderer = render::Renderer::new(&device, &queue, format, width, height, scale_factor);
        let (cols, rows) = renderer.grid_size_for(width, height);
        let terminal = term::Terminal::spawn(cols, rows, None).expect("启动子 shell 失败");

        Self {
            surface,
            device,
            queue,
            config,
            window,
            renderer,
            terminal,
            modifiers: winit::keyboard::ModifiersState::empty(),
        }
    }

    /// 窗口尺寸变化时重配置 surface。
    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);

        // 同步渲染器像素尺寸,并据此把终端网格 resize 到新的行列数
        //(会通过 PTY 通知子进程 SIGWINCH)。
        self.renderer.resize(width, height);
        let (cols, rows) = self.renderer.grid_size_for(width, height);
        self.terminal.resize(cols, rows);
    }

    /// 渲染一帧:抽取子进程输出 → 清屏 → 叠加终端网格文字。
    fn render(&mut self) -> Result<(), wgpu::SurfaceError> {
        // 抽干 PTY 输出并更新仿真网格(非阻塞)。
        self.terminal.pump();

        let frame = self.surface.get_current_texture()?;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("frame-encoder"),
            });

        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("clear-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.043,
                            g: 0.055,
                            b: 0.075,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
        }

        self.queue.submit(std::iter::once(encoder.finish()));

        // 在清屏之上叠加终端网格文字(glyphon 内部以 LoadOp::Load 自行提交)。
        let snapshot = self.terminal.snapshot();
        self.renderer
            .render(&snapshot, &self.device, &self.queue, &view);

        frame.present();
        Ok(())
    }
}

/// winit 应用状态。窗口在 resumed 时创建(winit 0.30 生命周期约定)。
#[derive(Default)]
struct App {
    gpu: Option<GpuState>,
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.gpu.is_some() {
            return;
        }
        let attrs = Window::default_attributes().with_title("Win-Term-Mac (Rust)");
        let window = Arc::new(
            event_loop
                .create_window(attrs)
                .expect("创建窗口失败"),
        );
        // wgpu 初始化是异步的,用 pollster 在此阻塞等待完成。
        let gpu = pollster::block_on(GpuState::new(window));
        self.gpu = Some(gpu);

        // 某些平台(尤其 Windows)在 `resumed` 里同步做完 GPU 初始化后,
        // 首帧窗口可能没有拿到键盘焦点,导致敲键盘收不到 `KeyboardInput`。
        // 这里显式请求一次焦点并触发首帧重绘,保证键盘链路一开始就通。
        if let Some(gpu) = self.gpu.as_ref() {
            gpu.window.focus_window();
            gpu.window.request_redraw();
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _id: WindowId,
        event: WindowEvent,
    ) {
        let Some(gpu) = self.gpu.as_mut() else {
            return;
        };

        match event {
            WindowEvent::CloseRequested => {
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                gpu.resize(size.width, size.height);
                gpu.window.request_redraw();
            }
            WindowEvent::RedrawRequested => {
                match gpu.render() {
                    Ok(()) => {}
                    // surface 丢失/过期时按当前尺寸重配。
                    Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                        let s = gpu.window.inner_size();
                        gpu.resize(s.width, s.height);
                    }
                    Err(wgpu::SurfaceError::OutOfMemory) => event_loop.exit(),
                    Err(e) => log::warn!("渲染跳过一帧: {e:?}"),
                }
            }
            WindowEvent::ModifiersChanged(new_mods) => {
                gpu.modifiers = new_mods.state();
            }
            WindowEvent::Focused(focused) => {
                // 诊断:确认窗口是否真正拿到键盘焦点(无焦点则收不到 KeyboardInput)。
                log::debug!("窗口焦点变化: focused={focused}");
            }
            WindowEvent::KeyboardInput { event, .. } => {
                // 约定:先给 keymap 判窗格热键,非热键再作为输入送进聚焦终端。
                // TODO(keymap): 接入 keymap 处理 Alt+方向 / Alt+Shift+± 等窗格操作。
                if let Some(bytes) = input::key_to_bytes(&event, gpu.modifiers) {
                    // 诊断:打印将写入 PTY 的字节。据此可区分故障位置——
                    //   有这行日志但终端无回显 => 写进去了、是渲染没接通(render 侧);
                    //   敲键完全没有这行日志 => 键根本没产字节(焦点/翻译问题)。
                    log::debug!("键盘输入 -> PTY {} 字节: {:?}", bytes.len(), bytes);
                    if let Err(e) = gpu.terminal.write_input(&bytes) {
                        // 写失败是"敲了没反应"的直接根因,必须显式暴露,不能吞掉。
                        log::warn!("写入 PTY 失败: {e}");
                    }
                    // 有输入即请求重绘,尽快让回显上屏(即便 about_to_wait 已在轮询)。
                    gpu.window.request_redraw();
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(gpu) = self.gpu.as_ref() {
            gpu.window.request_redraw();
        }
    }
}

fn main() {
    // 默认放开到 info:让诊断用的 warn(如"写入 PTY 失败")无需设 RUST_LOG 就可见。
    // 仍可用 RUST_LOG 覆盖——例如 `RUST_LOG=debug` 可看每次按键产生的 PTY 字节。
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let event_loop = EventLoop::new().expect("创建事件循环失败");
    // 持续重绘(终端有光标闪烁/输出更新);后续可改为按需 Wait。
    event_loop.set_control_flow(ControlFlow::Poll);

    let mut app = App::default();
    event_loop.run_app(&mut app).expect("事件循环异常退出");
}
