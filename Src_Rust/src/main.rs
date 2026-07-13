// Win-Term-Mac / Src_Rust —— 纯 Rust 自绘方案入口。
//
// 本文件负责【Scaffold】:打开一个 winit 窗口并初始化 wgpu(最小可运行),
// 具体的窗格树、终端仿真、命令面板、键位由各自模块实现。

// 各角色模块声明。对应文件由各自负责人创建:
mod pane; // 窗格二叉树:split / swap / move / navigate / walk / maximize
mod term; // 终端仿真 + PTY(alacritty_terminal + portable-pty)
mod palette; // 命令面板:低频强力操作(交换/移动窗格)入口
mod keymap; // 键位映射:热键与命令面板触发

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

        Self {
            surface,
            device,
            queue,
            config,
            window,
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
    }

    /// 渲染一帧。当前仅清屏为背景色。
    // TODO(render): 在此把窗格树(pane)与各叶子终端(term)绘制上去;
    //               命令面板(palette)作为覆盖层在最后绘制。
    fn render(&mut self) -> Result<(), wgpu::SurfaceError> {
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
            // TODO(input): 键盘事件交给 keymap 解析,再分发到 pane / palette。
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
    env_logger::init();

    let event_loop = EventLoop::new().expect("创建事件循环失败");
    // 持续重绘(终端有光标闪烁/输出更新);后续可改为按需 Wait。
    event_loop.set_control_flow(ControlFlow::Poll);

    let mut app = App::default();
    event_loop.run_app(&mut app).expect("事件循环异常退出");
}
