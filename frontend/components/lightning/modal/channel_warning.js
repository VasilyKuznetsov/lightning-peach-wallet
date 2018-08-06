import React, { Component } from "react";
import PropTypes from "prop-types";
import { connect } from "react-redux";
import { push } from "react-router-redux";
import { analytics } from "additional";
import { appOperations } from "modules/app";
import { ChannelsFullPath, LightningFullPath } from "routes";
import Modal from "components/modal";

class ChannelWarning extends Component {
    constructor(props) {
        super(props);

        analytics.pageview(`${LightningFullPath}/channel-warning`, "Attention. Create Channel");
    }

    closeModal = () => {
        const { dispatch } = this.props;
        analytics.event({ action: "Channel Warning Modal", category: "Lightning", label: "Cancel" });
        dispatch(appOperations.closeModal());
    };

    goToChannelHandler = () => {
        const { dispatch } = this.props;
        analytics.event({ action: "Channel Warning Modal", category: "Lightning", label: "Create Channel" });
        dispatch(appOperations.closeModal());
        dispatch(push(ChannelsFullPath));
    };

    render() {
        return (
            <Modal title="Attention!" onClose={this.closeModal} showCloseButton>
                <div className="modal-body text-center text-16">
                    <div className="row">
                        <div className="col-xs-12">
                            To make payments you must have an <strong>ACTIVE CHANNEL!</strong>
                        </div>
                    </div>
                </div>
                <div className="modal-footer text-center">
                    <div className="row">
                        <div className="col-xs-12">
                            <button
                                type="button"
                                className="button button__orange button__close"
                                onClick={this.goToChannelHandler}
                            >
                                Create channel
                            </button>
                        </div>
                    </div>
                </div>
            </Modal>
        );
    }
}

ChannelWarning.propTypes = {
    dispatch: PropTypes.func.isRequired,
};

export default connect(null)(ChannelWarning);
