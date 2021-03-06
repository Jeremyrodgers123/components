/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {
  Directive,
  Input,
  ViewContainerRef,
  Output,
  EventEmitter,
  Optional,
  OnDestroy,
  Inject,
  Injectable,
  InjectionToken,
} from '@angular/core';
import {DOCUMENT} from '@angular/common';
import {Directionality} from '@angular/cdk/bidi';
import {
  OverlayRef,
  Overlay,
  OverlayConfig,
  FlexibleConnectedPositionStrategy,
  ConnectedPosition,
} from '@angular/cdk/overlay';
import {TemplatePortal, Portal} from '@angular/cdk/portal';
import {coerceBooleanProperty, BooleanInput} from '@angular/cdk/coercion';
import {fromEvent, merge, Subject} from 'rxjs';
import {takeUntil} from 'rxjs/operators';
import {CdkMenuPanel} from './menu-panel';
import {MenuStack, MenuStackItem} from './menu-stack';

/**
 * Check if the given element is part of the cdk menu module or nested within a cdk menu element.
 * @param target the element to check.
 * @return true if the given element is part of the menu module or nested within a cdk menu element.
 */
function isWithinMenuElement(target: Element | null) {
  while (target instanceof Element) {
    if (target.className.indexOf('cdk-menu') !== -1) {
      return true;
    }
    target = target.parentElement;
  }
  return false;
}

/** Tracks the last open context menu trigger across the entire application. */
@Injectable({providedIn: 'root'})
export class ContextMenuTracker {
  /** The last open context menu trigger. */
  private static _openContextMenuTrigger?: CdkContextMenuTrigger;

  /**
   * Close the previous open context menu and set the given one as being open.
   * @param trigger the trigger for the currently open Context Menu.
   */
  update(trigger: CdkContextMenuTrigger) {
    if (ContextMenuTracker._openContextMenuTrigger !== trigger) {
      ContextMenuTracker._openContextMenuTrigger?.close();
      ContextMenuTracker._openContextMenuTrigger = trigger;
    }
  }
}

/** Configuration options passed to the context menu. */
export type ContextMenuOptions = {
  /** The opened menus X coordinate offset from the triggering position. */
  offsetX: number;

  /** The opened menus Y coordinate offset from the triggering position. */
  offsetY: number;
};

/** Injection token for the ContextMenu options object. */
export const CDK_CONTEXT_MENU_DEFAULT_OPTIONS = new InjectionToken<ContextMenuOptions>(
  'cdk-context-menu-default-options'
);

/** The coordinates of where the context menu should open. */
export type ContextMenuCoordinates = {x: number; y: number};

/**
 * A directive which when placed on some element opens a the Menu it is bound to when a user
 * right-clicks within that element. It is aware of nested Context Menus and the lowest level
 * non-disabled context menu will trigger.
 */
@Directive({
  selector: '[cdkContextMenuTriggerFor]',
  exportAs: 'cdkContextMenuTriggerFor',
  host: {
    '(contextmenu)': '_openOnContextMenu($event)',
  },
  providers: [
    // In cases where the first menu item in the context menu is a trigger the submenu opens on a
    // hover event. Offsetting the opened context menu by 2px prevents this from occurring.
    {provide: CDK_CONTEXT_MENU_DEFAULT_OPTIONS, useValue: {offsetX: 2, offsetY: 2}},
  ],
})
export class CdkContextMenuTrigger implements OnDestroy {
  /** Template reference variable to the menu to open on right click. */
  @Input('cdkContextMenuTriggerFor')
  get menuPanel(): CdkMenuPanel {
    return this._menuPanel;
  }
  set menuPanel(panel: CdkMenuPanel) {
    this._menuPanel = panel;

    if (this._menuPanel) {
      this._menuPanel._menuStack = this._menuStack;
    }
  }
  /** Reference to the MenuPanel this trigger toggles. */
  private _menuPanel: CdkMenuPanel;

  /** Emits when the attached menu is requested to open. */
  @Output('cdkContextMenuOpened') readonly opened: EventEmitter<void> = new EventEmitter();

  /** Emits when the attached menu is requested to close. */
  @Output('cdkContextMenuClosed') readonly closed: EventEmitter<void> = new EventEmitter();

  /** Whether the context menu should be disabled. */
  @Input('cdkContextMenuDisabled')
  get disabled() {
    return this._disabled;
  }
  set disabled(value: boolean) {
    this._disabled = coerceBooleanProperty(value);
  }
  private _disabled = false;

  /** A reference to the overlay which manages the triggered menu. */
  private _overlayRef: OverlayRef | null = null;

  /** The content of the menu panel opened by this trigger. */
  private _panelContent: TemplatePortal;

  /** Emits when the element is destroyed. */
  private readonly _destroyed: Subject<void> = new Subject();

  /** Reference to the document. */
  private readonly _document: Document;

  /** Emits when the document listener should stop. */
  private readonly _stopDocumentListener = merge(this.closed, this._destroyed);

  /** The menu stack for this trigger and its associated menus. */
  private readonly _menuStack = new MenuStack();

  constructor(
    protected readonly _viewContainerRef: ViewContainerRef,
    private readonly _overlay: Overlay,
    private readonly _contextMenuTracker: ContextMenuTracker,
    @Inject(CDK_CONTEXT_MENU_DEFAULT_OPTIONS) private readonly _options: ContextMenuOptions,
    @Inject(DOCUMENT) document: any,
    @Optional() private readonly _directionality?: Directionality
  ) {
    this._document = document;

    this._setMenuStackListener();
  }

  /**
   * Open the attached menu at the specified location.
   * @param coordinates where to open the context menu
   */
  open(coordinates: ContextMenuCoordinates) {
    if (this.disabled) {
      return;
    } else if (this.isOpen()) {
      // since we're moving this menu we need to close any submenus first otherwise they end up
      // disconnected from this one.
      this._menuStack.closeSubMenuOf(this._menuPanel._menu!);

      (this._overlayRef!.getConfig()
        .positionStrategy as FlexibleConnectedPositionStrategy).setOrigin(coordinates);
      this._overlayRef!.updatePosition();
    } else {
      this.opened.next();

      if (this._overlayRef) {
        (this._overlayRef.getConfig()
          .positionStrategy as FlexibleConnectedPositionStrategy).setOrigin(coordinates);
        this._overlayRef.updatePosition();
      } else {
        this._overlayRef = this._overlay.create(this._getOverlayConfig(coordinates));
      }

      this._overlayRef.attach(this._getMenuContent());
      this._setCloseListener();
    }
  }

  /** Close the opened menu. */
  close() {
    this._menuStack.closeAll();
  }

  /**
   * Open the context menu and close any previously open menus.
   * @param event the mouse event which opens the context menu.
   */
  _openOnContextMenu(event: MouseEvent) {
    if (!this.disabled) {
      // Prevent the native context menu from opening because we're opening a custom one.
      event.preventDefault();

      // Stop event propagation to ensure that only the closest enabled context menu opens.
      // Otherwise, any context menus attached to containing elements would *also* open,
      // resulting in multiple stacked context menus being displayed.
      event.stopPropagation();

      this._contextMenuTracker.update(this);
      this.open({x: event.clientX, y: event.clientY});
    }
  }

  /** Whether the attached menu is open. */
  isOpen() {
    return !!this._overlayRef?.hasAttached();
  }

  /**
   * Get the configuration object used to create the overlay.
   * @param coordinates the location to place the opened menu
   */
  private _getOverlayConfig(coordinates: ContextMenuCoordinates) {
    return new OverlayConfig({
      positionStrategy: this._getOverlayPositionStrategy(coordinates),
      scrollStrategy: this._overlay.scrollStrategies.block(),
      direction: this._directionality,
    });
  }

  /**
   * Build the position strategy for the overlay which specifies where to place the menu.
   * @param coordinates the location to place the opened menu
   */
  private _getOverlayPositionStrategy(
    coordinates: ContextMenuCoordinates
  ): FlexibleConnectedPositionStrategy {
    return this._overlay
      .position()
      .flexibleConnectedTo(coordinates)
      .withDefaultOffsetX(this._options.offsetX)
      .withDefaultOffsetY(this._options.offsetY)
      .withPositions(this._getOverlayPositions());
  }

  /**
   * Determine and return where to position the opened menu relative to the mouse location.
   */
  private _getOverlayPositions(): ConnectedPosition[] {
    // TODO: this should be configurable through the injected context menu options
    return [
      {originX: 'end', originY: 'top', overlayX: 'start', overlayY: 'top'},
      {originX: 'start', originY: 'top', overlayX: 'end', overlayY: 'top'},
      {originX: 'end', originY: 'bottom', overlayX: 'start', overlayY: 'bottom'},
      {originX: 'start', originY: 'bottom', overlayX: 'end', overlayY: 'bottom'},
    ];
  }

  /**
   * Get the portal to be attached to the overlay which contains the menu. Allows for the menu
   * content to change dynamically and be reflected in the application.
   */
  private _getMenuContent(): Portal<unknown> {
    const hasMenuContentChanged = this.menuPanel._templateRef !== this._panelContent?.templateRef;
    if (this.menuPanel && (!this._panelContent || hasMenuContentChanged)) {
      this._panelContent = new TemplatePortal(this.menuPanel._templateRef, this._viewContainerRef);
    }

    return this._panelContent;
  }

  /**
   * Subscribe to the document click and context menu events and close out the menu when emitted.
   */
  private _setCloseListener() {
    merge(fromEvent(this._document, 'click'), fromEvent(this._document, 'contextmenu'))
      .pipe(takeUntil(this._stopDocumentListener))
      .subscribe(event => {
        const target = event.composedPath ? event.composedPath()[0] : event.target;
        // stop the default context menu from appearing if user right-clicked somewhere outside of
        // any context menu directive or if a user right-clicked inside of the opened menu and just
        // close it.
        if (event.type === 'contextmenu') {
          if (target instanceof Element && isWithinMenuElement(target)) {
            // Prevent the native context menu from opening within any open context menu or submenu
            event.preventDefault();
          } else {
            this.close();
          }
        } else {
          if (target instanceof Element && !isWithinMenuElement(target)) {
            this.close();
          }
        }
      });
  }

  /** Subscribe to the menu stack close events and close this menu when requested. */
  private _setMenuStackListener() {
    this._menuStack.closed.pipe(takeUntil(this._destroyed)).subscribe((item: MenuStackItem) => {
      if (item === this._menuPanel._menu && this.isOpen()) {
        this.closed.next();
        this._overlayRef!.detach();
      }
    });
  }

  ngOnDestroy() {
    this._destroyOverlay();

    this._destroyed.next();
    this._destroyed.complete();
  }

  /** Destroy and unset the overlay reference it if exists. */
  private _destroyOverlay() {
    if (this._overlayRef) {
      this._overlayRef.dispose();
      this._overlayRef = null;
    }
  }

  static ngAcceptInputType_disabled: BooleanInput;
}
